require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { URL } = require('url');
const express = require('express');
const ShipStationClient = require('./src/services/shipstationClient');
const RithumClient = require('./src/services/rithumClient');
const { shipstationConfig, validateConfig: validateShipStationConfig } = require('./src/config/shipstationConfig');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

const TRACKING_FILE = path.join(__dirname, 'shipped_orders_tracking.json');
const PORT = process.env.WEBHOOK_PORT || 3001;

function normalizeEventType(rawType) {
    if (!rawType) {
        return null;
    }
    return String(rawType).toLowerCase();
}

function extractFulfillmentFromLegacyPayload(webhookData) {
    if (!webhookData || !webhookData.resource_url) {
        return null;
    }

    try {
        const resourceUrl = new URL(webhookData.resource_url);
        const shipmentId = resourceUrl.searchParams.get('shipment_id');
        const fulfillmentId = resourceUrl.searchParams.get('fulfillment_id');

        return {
            shipment_id: shipmentId,
            fulfillment_id: fulfillmentId,
            tracking_number: webhookData.tracking_number || webhookData.tracking || null,
            carrier_name: webhookData.carrier_name || webhookData.carrier || null,
            carrier_id: webhookData.carrier_id || null
        };
    } catch (error) {
        console.warn('⚠️  Could not parse resource_url:', error.message);
        return null;
    }
}

async function updateRithumOrderTracking(rithumClient, rithumOrderId, shipment, trackingInfo) {
    if (!rithumClient) {
        throw new Error('Rithum client not available');
    }

    if (!rithumOrderId) {
        throw new Error('Missing Rithum order ID');
    }

    const trackingNumber = trackingInfo?.tracking_number || shipment.tracking_number;
    const hasTrackingNumber = !!trackingNumber;

    const carrier = trackingInfo?.carrier_name || trackingInfo?.carrier_id || shipment.carrier_name || shipment.carrier_id || null;
    const shipDate = trackingInfo?.ship_date || shipment.ship_date || new Date().toISOString();

    const lineItems = (shipment.items || []).map(item => {
        const rawQuantity = item.quantity || item.ordered_quantity || 1;
        const quantity = Number(rawQuantity);
        if (!quantity || Number.isNaN(quantity) || quantity <= 0) {
            return null;
        }

        const lineItem = { quantity };
        const dscoItemId = item.external_order_item_id || item.sales_order_item_id || item.dsco_item_id || item.dscoItemId;
        if (dscoItemId != null && dscoItemId !== '') {
            lineItem.dscoItemId = String(dscoItemId);
        }

        if (!lineItem.dscoItemId) {
            if (item.sku) {
                lineItem.sku = String(item.sku);
            } else if (item.partner_sku || item.partnerSku) {
                lineItem.partnerSku = String(item.partner_sku || item.partnerSku);
            } else if (item.upc) {
                lineItem.upc = String(item.upc);
            }
        }

        if (!lineItem.dscoItemId && !lineItem.sku && !lineItem.partnerSku && !lineItem.upc) {
            return null;
        }

        return lineItem;
    }).filter(Boolean);

    if (lineItems.length === 0) {
        throw new Error('No identifiable line items found for Rithum shipment update');
    }

    const dscoOrderId = String(rithumOrderId);

    const statusUpdate = {
        dscoOrderId,
        updateType: 'STATUS',
        status: 'shipped'
    };

    if (lineItems.length > 0) {
        statusUpdate.payload = lineItems.map(item => ({
            ...(item.dscoItemId ? { dscoItemId: item.dscoItemId } : {}),
            ...(item.sku ? { sku: item.sku } : {}),
            ...(item.partnerSku ? { partnerSku: item.partnerSku } : {}),
            ...(item.upc ? { upc: item.upc } : {}),
            acceptedQuantity: item.quantity,
            status: 'accepted'
        }));
    }

    const statusResponse = await rithumClient.submitOrderUpdates(statusUpdate);

    return {
        shipmentResponse: null,
        statusResponse,
        usedShipmentEndpoint: false,
        trackingNumber
    };
}

/**
 * Step 2: Track Shipped Orders Info
 * 
 * This script processes ShipStation webhook events for shipped orders.
 * It extracts and tracks shipment and tracking information WITHOUT sending to Rithum.
 * 
 * Usage:
 * 1. As a webhook handler: POST webhook payload to this script
 * 2. As a standalone processor: Pass webhook payload as argument
 */

/**
 * Load existing tracked orders from file
 */
async function loadTrackedOrders() {
    try {
        const data = await fs.readFile(TRACKING_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist yet - return empty structure
            return {
                trackedOrders: [],
                lastUpdated: null,
                totalTracked: 0
            };
        }
        throw error;
    }
}

/**
 * Save tracked orders to file
 */
async function saveTrackedOrders(data) {
    try {
        await fs.writeFile(TRACKING_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`\n💾 Tracked orders saved to: ${TRACKING_FILE}\n`);
    } catch (error) {
        console.error(`\n❌ Failed to save tracking file: ${error.message}`);
        throw error;
    }
}

/**
 * Extract Rithum order ID from shipment
 * This is stored in customField2 or tags
 */
function extractRithumOrderId(shipment) {
    let rithumOrderId = null;

    // Method 1: Check tags (customField2 becomes a tag with name = dscoOrderId)
    if (shipment.tags && Array.isArray(shipment.tags)) {
        const dscoTag = shipment.tags.find(tag => {
            const tagName = tag.name || '';
            // Check if it's a numeric string (likely dscoOrderId) or contains dsco
            return tagName.match(/^\d+$/) || tagName.toLowerCase().includes('dsco');
        });
        if (dscoTag) {
            rithumOrderId = dscoTag.name;
        }
    }

    // Method 2: Check customField2 directly (if available in shipment)
    if (!rithumOrderId && shipment.customField2) {
        rithumOrderId = shipment.customField2;
    }

    // Method 3: Try to extract from shipment_number (fallback)
    if (!rithumOrderId && shipment.shipment_number) {
        // Only use if it looks like a Rithum order ID (numeric)
        if (shipment.shipment_number.match(/^\d+$/)) {
            rithumOrderId = shipment.shipment_number;
        }
    }

    return rithumOrderId;
}

/**
 * Process fulfillment_shipped_v2 webhook event
 */
async function processFulfillmentShippedWebhook(webhookData, shipstationClient, rithumClient) {
    try {
        let fulfillment = webhookData.fulfillment || webhookData.data;

        if (!fulfillment) {
            fulfillment = extractFulfillmentFromLegacyPayload(webhookData);
        }
        if (!fulfillment) {
            throw new Error('No fulfillment data in webhook payload');
        }

        const shipmentId = fulfillment.shipment_id;
        if (!shipmentId) {
            throw new Error('No shipment_id in fulfillment data');
        }

        console.log(`\n📦 Processing shipped order webhook:`);
        console.log(`   Shipment ID: ${shipmentId}`);
        console.log(`   Tracking Number: ${fulfillment.tracking_number || 'N/A'}`);
        console.log(`   Carrier: ${fulfillment.carrier_name || fulfillment.carrier_id || 'N/A'}`);

        // Get full shipment details from ShipStation
        console.log(`   🔍 Fetching full shipment details...`);
        const shipment = await shipstationClient.getShipmentById(shipmentId);
        const trackingInfo = await shipstationClient.getShipmentTracking(shipmentId);

        // Fallback: use fulfillment data if shipment tracking is not populated yet
        if (!trackingInfo.tracking_number && fulfillment.tracking_number) {
            trackingInfo.tracking_number = fulfillment.tracking_number;
        }
        if (!trackingInfo.carrier_name && (fulfillment.carrier_name || fulfillment.carrier_id)) {
            trackingInfo.carrier_name = fulfillment.carrier_name || fulfillment.carrier_id;
        }
        if (!trackingInfo.ship_date && fulfillment.ship_date) {
            trackingInfo.ship_date = fulfillment.ship_date;
        }

        // Extract Rithum order ID
        const rithumOrderId = extractRithumOrderId(shipment);

        // Build tracked order information
        const trackedOrder = {
            timestamp: new Date().toISOString(),
            webhookEvent: 'fulfillment_shipped_v2',
            shipment: {
                shipment_id: shipment.shipment_id,
                shipment_number: shipment.shipment_number,
                external_shipment_id: shipment.external_shipment_id,
                shipment_status: shipment.shipment_status,
                sales_order_id: shipment.sales_order_id,
                created_at: shipment.created_at,
                modified_at: shipment.modified_at
            },
            tracking: {
                tracking_number: trackingInfo.tracking_number || fulfillment.tracking_number,
                carrier_id: trackingInfo.carrier_id || shipment.carrier_id,
                carrier_name: trackingInfo.carrier_name || shipment.carrier_name,
                ship_date: trackingInfo.ship_date || shipment.ship_date,
                estimated_delivery_date: trackingInfo.estimated_delivery_date || shipment.estimated_delivery_date,
                packages: trackingInfo.packages || shipment.packages || []
            },
            shipping: {
                ship_to: shipment.ship_to || null,
                ship_from: shipment.ship_from || null
            },
            rithumOrderId: rithumOrderId || null,
            rithumUpdated: false,
            rithumUpdate: {
                attempted: !!rithumClient && !!rithumOrderId,
                success: false,
                updatedAt: null,
                trackingNumber: null,
                carrier: null,
                error: null
            },
            note: rithumClient ? 'Tracking captured - awaiting Rithum update' : 'Tracking captured locally - Rithum client unavailable'
        };

        // Attempt to update Rithum with tracking information
        if (rithumClient && rithumOrderId) {
            try {
                const { statusResponse, usedShipmentEndpoint, trackingNumber: submittedTracking } = await updateRithumOrderTracking(
                    rithumClient,
                    rithumOrderId,
                    shipment,
                    trackingInfo
                );

                trackedOrder.rithumUpdated = true;
                trackedOrder.rithumUpdate.success = true;
                trackedOrder.rithumUpdate.updatedAt = new Date().toISOString();
                trackedOrder.rithumUpdate.trackingNumber = submittedTracking;
                trackedOrder.rithumUpdate.carrier = trackedOrder.tracking.carrier_name || trackedOrder.tracking.carrier_id || null;
                trackedOrder.rithumUpdate.responses = {
                    status: statusResponse
                };

                trackedOrder.note = submittedTracking
                    ? 'Tracking recorded locally - order status updated in Rithum'
                    : 'Tracking missing - order status updated in Rithum';

                const logTrackingNumber = submittedTracking || 'N/A';
                console.log(`   ✅ Updated Rithum order ${rithumOrderId} (tracking: ${logTrackingNumber})`);
                if (!usedShipmentEndpoint) {
                    console.log('   ℹ️  Shipment endpoint skipped - only order status updated in Rithum');
                }
            } catch (error) {
                trackedOrder.rithumUpdated = false;
                trackedOrder.rithumUpdate.error = {
                    message: error.message,
                    status: error.response?.status,
                    data: error.response?.data
                };
                trackedOrder.note = 'Tracking captured locally - failed to update Rithum';

                console.error(`   ❌ Failed to update Rithum order ${rithumOrderId}:`, error.message);
                if (error.response) {
                    console.error('      Status:', error.response.status);
                    console.error('      Response:', JSON.stringify(error.response.data, null, 2));
                }
            }
        } else if (!rithumClient) {
            trackedOrder.rithumUpdate.attempted = false;
            trackedOrder.rithumUpdate.error = {
                message: 'Rithum client not configured'
            };
        } else {
            trackedOrder.rithumUpdate.error = {
                message: 'Rithum order ID not found on shipment'
            };
        }

        // Load existing tracked orders
        const trackingData = await loadTrackedOrders();

        // Check if this shipment was already tracked
        const existingIndex = trackingData.trackedOrders.findIndex(
            order => order.shipment.shipment_id === shipmentId
        );

        if (existingIndex >= 0) {
            // Update existing entry
            console.log(`   ⚠️  Shipment already tracked - updating entry`);
            trackingData.trackedOrders[existingIndex] = trackedOrder;
        } else {
            // Add new entry
            trackingData.trackedOrders.push(trackedOrder);
            trackingData.totalTracked = trackingData.trackedOrders.length;
        }

        trackingData.lastUpdated = new Date().toISOString();

        // Save to file
        await saveTrackedOrders(trackingData);

        console.log(`   ✅ Shipped order tracked successfully`);
        console.log(`   📊 Total tracked orders: ${trackingData.totalTracked}`);
        if (rithumOrderId) {
            console.log(`   🔗 Rithum Order ID: ${rithumOrderId}`);
            if (trackedOrder.rithumUpdated) {
                console.log('   📬 Rithum order updated successfully');
            } else if (trackedOrder.rithumUpdate.attempted) {
                console.log('   ⚠️  Failed to update Rithum order. See logs for details.');
            }
        } else {
            console.log(`   ⚠️  Rithum Order ID not found in shipment`);
        }

        return {
            success: true,
            trackedOrder,
            shipmentId,
            trackingNumber: trackedOrder.tracking.tracking_number
        };

    } catch (error) {
        console.error(`\n❌ Error processing fulfillment_shipped_v2 webhook:`, error.message);
        throw error;
    }
}

/**
 * Process webhook event
 */
async function processWebhookEvent(webhookData, shipstationClient, rithumClient) {
    const eventTypeRaw = webhookData.event || webhookData.webhook_event || webhookData.type || webhookData.resource_type;
    const eventType = normalizeEventType(eventTypeRaw);

    if (!eventType) {
        throw new Error('Missing event type in webhook payload');
    }

    console.log(`\n📨 Processing webhook event: ${eventTypeRaw}`);

    switch (eventType) {
        case 'fulfillment_shipped_v2':
        case 'fulfillment_shipped_v2 (legacy)':
        case 'fulfillment_shipped_v1':
        case 'fulfillment_shipped':
            return await processFulfillmentShippedWebhook(webhookData, shipstationClient, rithumClient);

        case 'label_created_v2':
            console.log(`   ℹ️  Label created event - shipment may not be fully shipped yet`);
            // Could track this too if needed, but fulfillment_shipped_v2 is more complete
            return {
                success: true,
                message: 'Label created event received (not tracking - waiting for fulfillment_shipped_v2)',
                eventType
            };

        case 'shipment_created_v2':
            console.log(`   ℹ️  Shipment created event - shipment may not be shipped yet`);
            return {
                success: true,
                message: 'Shipment created event received (not tracking - waiting for fulfillment_shipped_v2)',
                eventType
            };

        default:
            console.log(`   ℹ️  Unhandled event type: ${eventType}`);
            return {
                success: true,
                message: `Event type ${eventType} received but not specifically handled`,
                eventType
            };
    }
}

/**
 * Main function to process webhook
 */
async function trackShippedOrder(webhookPayload) {
    try {
        // Validate ShipStation configuration
        let shipstationClient = null;
        try {
            validateShipStationConfig();
            shipstationClient = new ShipStationClient(
                shipstationConfig.apiKey,
                shipstationConfig.baseUrl,
                shipstationConfig.warehouseId,
                shipstationConfig.shipFrom
            );
            console.log('✅ ShipStation client initialized\n');
        } catch (error) {
            console.error('❌ Failed to initialize ShipStation client:', error.message);
            throw new Error('ShipStation client not configured');
        }

        // Initialize Rithum client (optional but recommended)
        let rithumClient = null;
        try {
            validateRithumConfig();
            rithumClient = new RithumClient(
                rithumConfig.apiUrl,
                rithumConfig.clientId,
                rithumConfig.clientSecret
            );
            console.log('✅ Rithum client initialized\n');
        } catch (error) {
            console.warn('⚠️  Rithum client not available:', error.message);
            console.warn('   Tracking will be stored locally but not pushed to Rithum.');
        }

        // Process webhook
        const result = await processWebhookEvent(webhookPayload, shipstationClient, rithumClient);

        return result;

    } catch (error) {
        console.error('\n❌ Error tracking shipped order:', error.message);
        throw error;
    }
}

/**
 * Get tracking summary
 */
async function getTrackingSummary() {
    try {
        const trackingData = await loadTrackedOrders();
        
        console.log('\n' + '='.repeat(80));
        console.log('📊 Shipped Orders Tracking Summary');
        console.log('='.repeat(80));
        console.log(`   Total Tracked Orders: ${trackingData.totalTracked}`);
        console.log(`   Last Updated: ${trackingData.lastUpdated || 'Never'}`);
        
        if (trackingData.trackedOrders.length > 0) {
            console.log(`\n   Recent Orders (last 5):`);
            const recent = trackingData.trackedOrders.slice(-5).reverse();
            recent.forEach((order, index) => {
                console.log(`\n   ${index + 1}. Shipment: ${order.shipment.shipment_number || order.shipment.shipment_id}`);
                console.log(`      Tracking: ${order.tracking.tracking_number || 'N/A'}`);
                console.log(`      Carrier: ${order.tracking.carrier_name || 'N/A'}`);
                console.log(`      Rithum Order ID: ${order.rithumOrderId || 'Not found'}`);
                console.log(`      Rithum Updated: ${order.rithumUpdated ? 'Yes' : 'No'}`);
                console.log(`      Tracked At: ${order.timestamp}`);
                if (order.rithumUpdate?.error) {
                    console.log(`      Rithum Error: ${order.rithumUpdate.error.message || 'Unknown error'}`);
                }
            });
        }
        
        console.log('\n' + '='.repeat(80) + '\n');
        
        return trackingData;
    } catch (error) {
        console.error('Error getting tracking summary:', error.message);
        throw error;
    }
}

/**
 * Start Express server to receive webhooks
 * Perfect for use with ngrok!
 */
function startWebhookServer() {
    const app = express();
    
    // Middleware
    app.use(express.json());
    
    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            service: 'Webhook Step 2 - Shipped Orders Tracker',
            timestamp: new Date().toISOString()
        });
    });
    
    const webhookHandler = async (req, res) => {
        try {
            console.log('\n' + '='.repeat(80));
            console.log('📨 Received webhook request');
            console.log('='.repeat(80));

            // Process the webhook
            const result = await trackShippedOrder(req.body);

            res.status(200).json({
                success: true,
                message: 'Webhook processed successfully',
                ...result
            });
        } catch (error) {
            console.error('Error processing webhook:', error.message);
            res.status(200).json({
                success: false,
                message: 'Error processing webhook',
                error: error.message
            });
        }
    };

    // Webhook endpoints - accepts base path and API-style path
    app.post('/webhook', webhookHandler);
    app.post('/api/shipstation/webhooks/v2', webhookHandler);
    
    // Summary endpoint
    app.get('/summary', async (req, res) => {
        try {
            const summary = await getTrackingSummary();
            res.json({
                success: true,
                ...summary
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });
    
    // Start server
    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(80));
        console.log('🚀 Webhook Step 2 Server Started');
        console.log('='.repeat(80));
        console.log(`   Local URL: http://localhost:${PORT}`);
        console.log(`   Webhook Endpoint: http://localhost:${PORT}/webhook`);
        console.log(`   Health Check: http://localhost:${PORT}/health`);
        console.log(`   Summary: http://localhost:${PORT}/summary`);
        console.log('\n📡 To use with ngrok:');
        console.log(`   1. Run: ngrok http ${PORT}`);
        console.log(`   2. Copy the ngrok URL (e.g., https://abc123.ngrok.io)`);
        console.log(`   3. Configure ShipStation webhook to: https://abc123.ngrok.io/webhook`);
        console.log(`   4. Event type: fulfillment_shipped_v2`);
        console.log('\n' + '='.repeat(80) + '\n');
    });
}

// Export functions for use as module
module.exports = {
    trackShippedOrder,
    processWebhookEvent,
    getTrackingSummary,
    loadTrackedOrders
};

// Run if called directly
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args[0] === '--server' || args[0] === '--serve') {
        // Start webhook server (for use with ngrok)
        startWebhookServer();
    } else if (args.length === 0) {
        // No arguments - show summary
        getTrackingSummary().catch(error => {
            console.error('Error:', error.message);
            process.exit(1);
        });
    } else if (args[0] === '--summary' || args[0] === '-s') {
        // Show summary
        getTrackingSummary().catch(error => {
            console.error('Error:', error.message);
            process.exit(1);
        });
    } else {
        // Process webhook payload from command line (JSON string)
        try {
            const webhookPayload = JSON.parse(args[0]);
            trackShippedOrder(webhookPayload)
                .then(result => {
                    console.log('\n✅ Webhook processed successfully');
                    process.exit(0);
                })
                .catch(error => {
                    console.error('\n❌ Failed to process webhook:', error.message);
                    process.exit(1);
                });
        } catch (error) {
            console.error('❌ Invalid JSON payload:', error.message);
            console.log('\nUsage:');
            console.log('  node webhook_step2.js                    # Show summary');
            console.log('  node webhook_step2.js --summary          # Show summary');
            console.log('  node webhook_step2.js --server           # Start webhook server (for ngrok)');
            console.log('  node webhook_step2.js \'{"event":"fulfillment_shipped_v2",...}\'  # Process webhook');
            process.exit(1);
        }
    }
}
