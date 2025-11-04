
require('dotenv').config();
const express = require('express');
const ShipStationClient = require('./src/services/shipstationClient');
const RithumClient = require('./src/services/rithumClient');
const { shipstationConfig, validateConfig: validateShipStationConfig } = require('./src/config/shipstationConfig');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

const PORT = process.env.PORT || 8000;
const WEBHOOK_PATH = '/api/shipstation/webhooks/v2';

// Initialize clients
let shipstationClient = null;
let rithumClient = null;

try {
    validateShipStationConfig();
    shipstationClient = new ShipStationClient(
        shipstationConfig.apiKey,
        shipstationConfig.baseUrl,
        shipstationConfig.warehouseId,
        shipstationConfig.shipFrom
    );
    console.log('✅ ShipStation client initialized');
} catch (error) {
    console.error('❌ Failed to initialize ShipStation client:', error.message);
    console.error('⚠️  Webhook processing will be limited.\n');
}

try {
    validateRithumConfig();
    rithumClient = new RithumClient(
        rithumConfig.apiUrl,
        rithumConfig.clientId,
        rithumConfig.clientSecret
    );
    console.log('✅ Rithum client initialized');
} catch (error) {
    console.error('❌ Failed to initialize Rithum client:', error.message);
    console.error('⚠️  Cannot update Rithum orders.\n');
}

/**
 * Extract Rithum order ID from ShipStation shipment
 * Per Project.md: Rithum order ID is stored in customField2 (which becomes a tag in v2)
 * @param {Object} shipment - ShipStation shipment object
 * @returns {Promise<string|null>} Rithum order ID or null
 */
async function extractRithumOrderId(shipment) {
    try {
        // Method 1: Check tags (customField2 becomes a tag with name = dscoOrderId)
        // Per Project.md: customField2 stores dscoOrderId for tracking
        if (shipment.tags && Array.isArray(shipment.tags)) {
            // Look for tag that matches dscoOrderId pattern (numeric string)
            // Tags are stored as { name: "value" }, so customField2 becomes { name: dscoOrderId }
            const dscoTag = shipment.tags.find(tag => {
                const tagName = tag.name || '';
                // Check if it's a numeric string (likely dscoOrderId) or contains dsco
                return tagName.match(/^\d+$/) || tagName.toLowerCase().includes('dsco');
            });
            if (dscoTag) {
                console.log(`   Found Rithum order ID in shipment tags: ${dscoTag.name}`);
                return dscoTag.name;
            }
        }

        // Method 2: Try to get from sales_order and find original order data
        // The shipment might have a link to the sales order which has customField2
        if (shipment.sales_order_id && shipstationClient) {
            try {
                const order = await shipstationClient.getOrderById(shipment.sales_order_id);
                // In v2, orders might have customField2 directly or in tags
                if (order.customField2) {
                    console.log(`   Found Rithum order ID in sales order customField2: ${order.customField2}`);
                    return order.customField2;
                } else if (order.tags && Array.isArray(order.tags)) {
                    const dscoTag = order.tags.find(tag => {
                        const tagName = tag.name || '';
                        return tagName.match(/^\d+$/) || tagName.toLowerCase().includes('dsco');
                    });
                    if (dscoTag) {
                        console.log(`   Found Rithum order ID in sales order tags: ${dscoTag.name}`);
                        return dscoTag.name;
                    }
                }
            } catch (error) {
                console.warn(`   Could not get order to extract Rithum ID: ${error.message}`);
            }
        }

        // Method 3: Try to extract from shipment_number (fallback)
        // This only works if shipment_number is the Rithum order ID
        if (shipment.shipment_number) {
            // Only use if it looks like a Rithum order ID (numeric)
            if (shipment.shipment_number.match(/^\d+$/)) {
                console.log(`   Using shipment_number as Rithum order ID (fallback): ${shipment.shipment_number}`);
                return shipment.shipment_number;
            }
        }

        return null;
    } catch (error) {
        console.error('Error extracting Rithum order ID:', error.message);
        return null;
    }
}

/**
 * Update Rithum order with tracking information
 * @param {string} rithumOrderId - Rithum order ID (dscoOrderId)
 * @param {Object} trackingInfo - Tracking information object
 */
async function updateRithumOrder(rithumOrderId, trackingInfo) {
    try {
        if (!rithumClient) {
            throw new Error('Rithum client not initialized');
        }

        const { trackingNumber, carrier, shipDate } = trackingInfo;

        if (!trackingNumber) {
            throw new Error('Tracking number is required');
        }

        console.log(`📤 Updating Rithum order ${rithumOrderId} with tracking information:`);
        console.log(`   Tracking Number: ${trackingNumber}`);
        console.log(`   Carrier: ${carrier || 'N/A'}`);
        console.log(`   Ship Date: ${shipDate || 'N/A'}`);

        const updateData = {
            packages: [{
                trackingNumber: trackingNumber,
                carrier: carrier || 'Unknown',
                shipDate: shipDate || new Date().toISOString()
            }]
        };

        await rithumClient.updateOrder(rithumOrderId, updateData);
        console.log(`✅ Successfully updated Rithum order ${rithumOrderId} with tracking ${trackingNumber}`);

        return {
            success: true,
            rithumOrderId,
            trackingNumber,
            carrier,
            shipDate
        };
    } catch (error) {
        console.error(`❌ Failed to update Rithum order ${rithumOrderId}:`, error.message);
        throw error;
    }
}

/**
 * Process fulfillment_shipped_v2 webhook event
 * @param {Object} webhookData - Webhook payload
 * @returns {Promise<Object>} Processing result
 */
async function processFulfillmentShippedV2(webhookData) {
    try {
        console.log('\n📦 Processing fulfillment_shipped_v2 webhook event...\n');

        const fulfillment = webhookData.fulfillment || webhookData.data || webhookData;
        const shipmentId = fulfillment.shipment_id;

        if (!shipmentId) {
            throw new Error('Missing shipment_id in fulfillment_shipped_v2 webhook');
        }

        console.log(`   Shipment ID: ${shipmentId}`);
        console.log(`   Tracking Number: ${fulfillment.tracking_number || 'N/A'}`);

        // Get full shipment details to extract Rithum order ID
        if (!shipstationClient) {
            throw new Error('ShipStation client not initialized');
        }

        const shipment = await shipstationClient.getShipmentById(shipmentId);
        console.log(`   Shipment Number: ${shipment.shipment_number || 'N/A'}`);

        // Extract Rithum order ID from shipment (using ShipStationClient method or fallback)
        let rithumOrderId = null;
        if (shipstationClient.extractRithumOrderId) {
            // Try to get order if available
            let order = null;
            if (shipment.sales_order_id) {
                try {
                    order = await shipstationClient.getOrderById(shipment.sales_order_id);
                } catch (error) {
                    console.warn(`   Could not get order: ${error.message}`);
                }
            }
            rithumOrderId = shipstationClient.extractRithumOrderId(shipment, order);
        } else {
            // Fallback to our local function
            rithumOrderId = await extractRithumOrderId(shipment);
        }

        if (!rithumOrderId) {
            console.warn('⚠️  Could not find Rithum order ID in ShipStation shipment');
            console.log('   Shipment tags:', shipment.tags);
            console.log('   Shipment number:', shipment.shipment_number);
            return {
                success: false,
                error: 'Could not find Rithum order ID',
                shipmentId
            };
        }

        // Get tracking information
        const trackingInfo = {
            trackingNumber: fulfillment.tracking_number || shipment.tracking_number,
            carrier: fulfillment.carrier_name || fulfillment.carrier_id || shipment.carrier_name || shipment.carrier_id,
            shipDate: fulfillment.ship_date || shipment.ship_date
        };

        // If tracking number is missing, try to get from shipment
        if (!trackingInfo.trackingNumber && shipmentId) {
            try {
                const tracking = await shipstationClient.getShipmentTracking(shipmentId);
                if (tracking.tracking_number) {
                    trackingInfo.trackingNumber = tracking.tracking_number;
                }
                if (tracking.carrier_name && !trackingInfo.carrier) {
                    trackingInfo.carrier = tracking.carrier_name;
                }
            } catch (error) {
                console.warn(`   Could not get tracking info: ${error.message}`);
            }
        }

        if (!trackingInfo.trackingNumber) {
            console.warn(`⚠️  No tracking number found for shipment ${shipmentId}`);
            return {
                success: false,
                error: 'No tracking number found',
                shipmentId,
                rithumOrderId
            };
        }

        // Update Rithum order
        const updateResult = await updateRithumOrder(rithumOrderId, trackingInfo);

        return {
            success: true,
            event: 'fulfillment_shipped_v2',
            shipmentId,
            rithumOrderId,
            ...updateResult
        };
    } catch (error) {
        console.error('❌ Error processing fulfillment_shipped_v2:', error.message);
        throw error;
    }
}

/**
 * Process webhook event
 * @param {Object} webhookData - Webhook payload
 * @returns {Promise<Object>} Processing result
 */
async function processWebhook(webhookData) {
    try {
        const eventType = webhookData.event || webhookData.webhook_event || webhookData.type;

        if (!eventType) {
            throw new Error('Missing event type in webhook payload');
        }

        console.log(`\n📨 Processing webhook event: ${eventType}\n`);

        switch (eventType) {
            case 'fulfillment_shipped_v2':
                return await processFulfillmentShippedV2(webhookData);

            case 'label_created_v2':
                console.log('ℹ️  label_created_v2 event received (label created, order may not be shipped yet)');
                return {
                    success: true,
                    event: eventType,
                    message: 'Label created - shipment may not be shipped yet'
                };

            case 'shipment_created_v2':
                console.log('ℹ️  shipment_created_v2 event received (shipment created, order may not be shipped yet)');
                return {
                    success: true,
                    event: eventType,
                    message: 'Shipment created - order may not be shipped yet'
                };

            case 'track_event_v2':
                console.log('ℹ️  track_event_v2 event received (tracking update, order already shipped)');
                return {
                    success: true,
                    event: eventType,
                    message: 'Tracking event - order already shipped'
                };

            default:
                console.log(`ℹ️  Unhandled webhook event type: ${eventType}`);
                return {
                    success: true,
                    event: eventType,
                    message: `Event type ${eventType} received but not specifically handled`
                };
        }
    } catch (error) {
        console.error('❌ Error processing webhook:', error.message);
        throw error;
    }
}

// Create Express app for webhook server
const app = express();

// Middleware
app.use(express.json());

// Health check
app.get('/ping', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Step 2 Webhook Handler',
        timestamp: new Date().toISOString()
    });
});

// Webhook endpoint
app.post(WEBHOOK_PATH, async (req, res) => {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('📨 Received ShipStation Webhook');
        console.log('='.repeat(80));
        console.log(JSON.stringify(req.body, null, 2));
        console.log('='.repeat(80) + '\n');

        const result = await processWebhook(req.body);

        // Always return 200 to acknowledge receipt (per ShipStation webhook requirements)
        res.status(200).json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('\n❌ Webhook processing error:', error.message);
        // Still return 200 to prevent webhook retries
        res.status(200).json({
            success: false,
            error: error.message
        });
    }
});

// Main execution
async function main() {
    const args = process.argv.slice(2);
    const isPayloadMode = args.includes('--payload');

    if (isPayloadMode) {
        // Process webhook payload from stdin
        console.log('📦 Step 2: Process Webhook Payload\n');
        console.log('='.repeat(80) + '\n');

        let input = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            input += chunk;
        });
        process.stdin.on('end', async () => {
            try {
                const webhookData = JSON.parse(input);
                const result = await processWebhook(webhookData);
                console.log('\n' + '='.repeat(80));
                console.log('\n📊 Result:');
                console.log(JSON.stringify(result, null, 2));
                process.exit(result.success ? 0 : 1);
            } catch (error) {
                console.error('❌ Error:', error.message);
                process.exit(1);
            }
        });
    } else {
        // Start webhook server
        console.log('📦 Step 2: Webhook Handler Server\n');
        console.log('='.repeat(80) + '\n');
        console.log('📋 Flow (Step 2 - Webhook per Project.md):');
        console.log('   1. Receive webhook events from ShipStation (fulfillment_shipped_v2, etc.)');
        console.log('   2. Extract tracking information from webhook payload');
        console.log('   3. Find Rithum order ID from shipment tags/customField2');
        console.log('   4. Update Rithum order with tracking information');
        console.log('\n💡 Webhook Endpoint:');
        console.log(`   POST http://localhost:${PORT}${WEBHOOK_PATH}`);
        console.log('\n📝 Configure in ShipStation:');
        console.log('   Event: fulfillment_shipped_v2');
        console.log(`   URL: https://your-domain.com${WEBHOOK_PATH}`);
        console.log('\n' + '='.repeat(80) + '\n');

        if (!shipstationClient) {
            console.error('⚠️  ShipStation client not initialized - webhook processing will be limited');
        }
        if (!rithumClient) {
            console.error('⚠️  Rithum client not initialized - cannot update Rithum orders');
        }

        app.listen(PORT, () => {
            console.log(`✅ Webhook server listening on port ${PORT}`);
            console.log(`📡 Webhook endpoint: http://localhost:${PORT}${WEBHOOK_PATH}\n`);
        });
    }
}

// Run main function
main().catch(error => {
    console.error('❌ Fatal error:', error.message);
    process.exit(1);
});

