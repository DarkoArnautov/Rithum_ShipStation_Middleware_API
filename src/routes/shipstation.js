const express = require('express');
const ShipStationClient = require('../services/shipstationClient');
const RithumClient = require('../services/rithumClient');
const { shipstationConfig, validateConfig } = require('../config/shipstationConfig');
const { rithumConfig } = require('../config/rithumConfig');

const router = express.Router();

// Initialize clients
let shipstationClient = null;
let rithumClient = null;

try {
    validateConfig();
    shipstationClient = new ShipStationClient(
        shipstationConfig.apiKey,
        shipstationConfig.baseUrl,
        shipstationConfig.warehouseId,
        shipstationConfig.shipFrom
    );
} catch (error) {
    console.warn('ShipStation client not initialized:', error.message);
}

try {
    rithumClient = new RithumClient(
        rithumConfig.apiUrl,
        rithumConfig.clientId,
        rithumConfig.clientSecret
    );
} catch (error) {
    console.warn('Rithum client not initialized:', error.message);
}

/**
 * GET /api/shipstation/ping
 * Health check for ShipStation
 */
router.get('/ping', (req, res) => {
    res.json({
        status: 'ok',
        service: 'ShipStation Integration',
        timestamp: new Date().toISOString()
    });
});

/**
 * GET /api/shipstation/test
 * Test connection to ShipStation API
 */
router.get('/test', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const result = await shipstationClient.testConnection();
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('ShipStation test connection error:', error);
        res.status(500).json({
            success: false,
            message: 'Test connection failed',
            error: error.message
        });
    }
});

/**
 * POST /api/shipstation/webhooks/order-notify
 * Webhook endpoint for ShipStation order notifications (v1 style - legacy)
 * Handles v1 ORDER_NOTIFY events
 */
router.post('/webhooks/order-notify', async (req, res) => {
    try {
        console.log('Received ShipStation v1 webhook:', req.body);

        const { resource_url, resource_type } = req.body;

        if (resource_type !== 'ORDER_NOTIFY') {
            return res.status(400).json({
                success: false,
                message: 'Invalid resource type'
            });
        }

        if (!resource_url) {
            return res.status(400).json({
                success: false,
                message: 'Missing resource_url'
            });
        }

        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        // Try to extract shipment ID or order ID from resource_url
        let shipmentId = null;
        let orderId = null;
        
        const shipmentMatch = resource_url.match(/\/shipments\/([^\/]+)/);
        const orderMatch = resource_url.match(/\/orders\/([^\/]+)/);
        
        if (shipmentMatch) {
            shipmentId = shipmentMatch[1];
        } else if (orderMatch) {
            orderId = orderMatch[1];
        } else {
            return res.status(400).json({
                success: false,
                message: 'Could not extract shipment ID or order ID from resource_url'
            });
        }

        // Get tracking information
        let trackingInfo = null;
        let shipment = null;

        if (shipmentId) {
            shipment = await shipstationClient.getShipmentById(shipmentId);
            trackingInfo = await shipstationClient.getShipmentTracking(shipmentId);
        } else if (orderId) {
            try {
                const order = await shipstationClient.getOrderById(orderId);
                if (order.sales_order_id || order.id) {
                    const shipmentsResponse = await shipstationClient.client.get('/v2/shipments', {
                        params: {
                            sales_order_id: order.sales_order_id || order.id,
                            page_size: 1
                        }
                    });
                    const shipments = shipmentsResponse.data?.shipments || [];
                    if (shipments.length > 0) {
                        shipment = shipments[0];
                        trackingInfo = await shipstationClient.getShipmentTracking(shipment.shipment_id);
                    }
                }
            } catch (error) {
                console.warn('Could not get order or shipment:', error.message);
            }
        }

        if (!trackingInfo && !shipment) {
            return res.status(404).json({
                success: false,
                message: 'Could not find shipment or tracking information'
            });
        }

        console.log('Processing ShipStation v1 webhook:', {
            shipmentId: shipmentId || shipment?.shipment_id,
            orderId,
            shipmentStatus: shipment?.shipment_status,
            trackingNumber: trackingInfo?.tracking_number
        });

        // Update Rithum with tracking information if shipment is shipped
        if (shipment && (shipment.shipment_status === 'label_purchased' || shipment.shipment_status === 'shipped')) {
            await updateRithumWithTracking(shipment, trackingInfo);
        }

        res.json({
            success: true,
            message: 'Webhook processed successfully',
            shipmentId: shipmentId || shipment?.shipment_id,
            orderId
        });

    } catch (error) {
        console.error('Error processing ShipStation webhook:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to process webhook',
            error: error.message
        });
    }
});

/**
 * POST /api/shipstation/webhooks/v2
 * Webhook endpoint for ShipStation v2 API webhook events
 * Handles v2 webhook events: fulfillment_shipped_v2, label_created_v2, shipment_created_v2, track_event_v2, etc.
 * 
 * V2 webhook payload structure varies by event type:
 * - fulfillment_shipped_v2: Contains fulfillment data with shipment_id, tracking_number, etc.
 * - label_created_v2: Contains label/shipment data
 * - shipment_created_v2: Contains shipment data
 * - track_event_v2: Contains tracking event data
 */
router.post('/webhooks/v2', async (req, res) => {
    try {
        console.log('Received ShipStation v2 webhook:', JSON.stringify(req.body, null, 2));

        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const webhookData = req.body;
        const eventType = webhookData.event || webhookData.webhook_event || webhookData.type;
        
        if (!eventType) {
            console.warn('Received webhook without event type:', webhookData);
            return res.status(400).json({
                success: false,
                message: 'Missing event type in webhook payload'
            });
        }

        console.log(`Processing v2 webhook event: ${eventType}`);

        let result = {
            success: true,
            event: eventType,
            message: 'Webhook processed successfully'
        };

        // Handle different v2 webhook event types
        switch (eventType) {
            case 'fulfillment_shipped_v2':
                // Fulfillment has been shipped - contains tracking info
                if (webhookData.fulfillment || webhookData.data) {
                    const fulfillment = webhookData.fulfillment || webhookData.data;
                    const shipmentId = fulfillment.shipment_id;
                    const trackingNumber = fulfillment.tracking_number;
                    
                    console.log('Processing fulfillment_shipped_v2:', {
                        shipmentId,
                        trackingNumber,
                        carrier: fulfillment.carrier_name || fulfillment.carrier_id
                    });

                    // Get full shipment details
                    if (shipmentId) {
                        try {
                            const shipment = await shipstationClient.getShipmentById(shipmentId);
                            const trackingInfo = await shipstationClient.getShipmentTracking(shipmentId);
                            
                            // Update Rithum with tracking information
                            await updateRithumWithTracking(shipment, trackingInfo);
                            
                            result.shipmentId = shipmentId;
                            result.trackingNumber = trackingNumber;
                        } catch (error) {
                            console.error('Error processing fulfillment_shipped_v2:', error.message);
                        }
                    }
                }
                break;

            case 'label_created_v2':
                // Label has been created - shipment is ready
                if (webhookData.shipment || webhookData.data) {
                    const shipment = webhookData.shipment || webhookData.data;
                    const shipmentId = shipment.shipment_id;
                    
                    console.log('Processing label_created_v2:', {
                        shipmentId,
                        shipmentNumber: shipment.shipment_number
                    });

                    if (shipmentId) {
                        try {
                            const trackingInfo = await shipstationClient.getShipmentTracking(shipmentId);
                            result.shipmentId = shipmentId;
                            result.trackingNumber = trackingInfo.tracking_number;
                        } catch (error) {
                            console.error('Error processing label_created_v2:', error.message);
                        }
                    }
                }
                break;

            case 'shipment_created_v2':
                // New shipment has been created
                if (webhookData.shipment || webhookData.data) {
                    const shipment = webhookData.shipment || webhookData.data;
                    console.log('Processing shipment_created_v2:', {
                        shipmentId: shipment.shipment_id,
                        shipmentNumber: shipment.shipment_number
                    });
                    result.shipmentId = shipment.shipment_id;
                }
                break;

            case 'track_event_v2':
                // Tracking event occurred (package status update)
                if (webhookData.tracking || webhookData.data) {
                    const tracking = webhookData.tracking || webhookData.data;
                    console.log('Processing track_event_v2:', {
                        trackingNumber: tracking.tracking_number,
                        status: tracking.status,
                        event: tracking.event
                    });
                    result.trackingNumber = tracking.tracking_number;
                    result.status = tracking.status;
                }
                break;

            case 'batch_processed_v2':
                // Batch of labels has been processed
                console.log('Processing batch_processed_v2:', {
                    batchId: webhookData.batch_id || webhookData.data?.batch_id
                });
                result.batchId = webhookData.batch_id || webhookData.data?.batch_id;
                break;

            case 'fulfillment_rejected_v2':
                // Fulfillment was rejected
                console.log('Processing fulfillment_rejected_v2:', {
                    fulfillmentId: webhookData.fulfillment_id || webhookData.data?.fulfillment_id
                });
                result.fulfillmentId = webhookData.fulfillment_id || webhookData.data?.fulfillment_id;
                break;

            default:
                console.log(`Unhandled v2 webhook event type: ${eventType}`);
                result.message = `Event type ${eventType} received but not specifically handled`;
        }

        // Always return 200 to acknowledge receipt
        res.json(result);

    } catch (error) {
        console.error('Error processing ShipStation v2 webhook:', error);
        // Still return 200 to prevent webhook retries
        res.status(200).json({
            success: false,
            message: 'Error processing webhook',
            error: error.message
        });
    }
});

/**
 * Update Rithum order with tracking information from ShipStation (v2 API)
 * @param {Object} shipment - ShipStation shipment object
 * @param {Object} trackingInfo - Tracking information object
 */
async function updateRithumWithTracking(shipment, trackingInfo) {
    try {
        if (!rithumClient) {
            console.warn('Rithum client not available, skipping tracking update');
            return;
        }

        // Extract Rithum order ID from shipment
        // In v2, custom fields (customField2) are stored as tags
        // We store dscoOrderId in customField2, which becomes a tag
        let rithumOrderId = null;
        
        // Method 1: Check tags (customField2 becomes a tag with name = dscoOrderId)
        if (shipment.tags && Array.isArray(shipment.tags)) {
            // Look for tag that matches dscoOrderId pattern (numeric string)
            // Tags are stored as { name: "value" }, so customField2 becomes { name: dscoOrderId }
            const dscoTag = shipment.tags.find(tag => {
                const tagName = tag.name || '';
                // Check if it's a numeric string (likely dscoOrderId) or contains dsco
                return tagName.match(/^\d+$/) || tagName.toLowerCase().includes('dsco');
            });
            if (dscoTag) {
                rithumOrderId = dscoTag.name;
            }
        }

        // Method 2: Try to get from sales_order and find original order data
        // The shipment might have a link to the sales order which has customField2
        if (!rithumOrderId && shipment.sales_order_id) {
            try {
                const order = await shipstationClient.getOrderById(shipment.sales_order_id);
                // In v2, orders might have customField2 directly or in tags
                if (order.customField2) {
                    rithumOrderId = order.customField2;
                } else if (order.tags && Array.isArray(order.tags)) {
                    const dscoTag = order.tags.find(tag => {
                        const tagName = tag.name || '';
                        return tagName.match(/^\d+$/) || tagName.toLowerCase().includes('dsco');
                    });
                    if (dscoTag) {
                        rithumOrderId = dscoTag.name;
                    }
                }
            } catch (error) {
                console.warn('Could not get order to extract Rithum ID:', error.message);
            }
        }

        // Method 3: Try to extract from shipment_number (fallback)
        // This only works if shipment_number is the Rithum order ID
        if (!rithumOrderId && shipment.shipment_number) {
            // Only use if it looks like a Rithum order ID (numeric)
            if (shipment.shipment_number.match(/^\d+$/)) {
                rithumOrderId = shipment.shipment_number;
            }
        }

        if (!rithumOrderId) {
            console.warn('Could not find Rithum order ID in ShipStation shipment');
            console.log('Shipment tags:', shipment.tags);
            console.log('Shipment number:', shipment.shipment_number);
            return;
        }

        // Get tracking information
        const trackingNumber = trackingInfo?.tracking_number || shipment.tracking_number;
        const carrier = trackingInfo?.carrier_name || shipment.carrier_name || shipment.carrier_id;
        const shipDate = trackingInfo?.ship_date || shipment.ship_date;

            if (!trackingNumber) {
            console.warn(`No tracking number found for shipment ${shipment.shipment_id}`);
            return;
            }

            console.log(`Updating Rithum order ${rithumOrderId} with tracking:`, {
                trackingNumber,
                carrier,
            shipDate,
            shipmentId: shipment.shipment_id
            });

            const updateData = {
                packages: [{
                    trackingNumber: trackingNumber,
                    carrier: carrier,
                    shipDate: shipDate
                }]
            };

            await rithumClient.updateOrder(rithumOrderId, updateData);
            console.log(`Successfully updated Rithum order ${rithumOrderId} with tracking ${trackingNumber}`);

    } catch (error) {
        console.error('Error updating Rithum with tracking:', error);
        throw error;
    }
}

/**
 * GET /api/shipstation/status
 * Get ShipStation integration status
 */
router.get('/status', (req, res) => {
    res.json({
        configured: !!shipstationClient,
        baseUrl: shipstationConfig.baseUrl,
        hasApiKey: !!shipstationConfig.apiKey,
        warehouseId: shipstationConfig.warehouseId || null
    });
});

/**
 * GET /api/shipstation/warehouses
 * List all warehouses in ShipStation
 */
router.get('/warehouses', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const warehouses = await shipstationClient.getWarehouses();
        
        res.json({
            success: true,
            warehouses: warehouses,
            count: warehouses.length,
            defaultWarehouse: warehouses.find(w => w.is_default) || warehouses[0] || null
        });
    } catch (error) {
        console.error('Error fetching warehouses:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch warehouses',
            error: error.message
        });
    }
});

/**
 * GET /api/shipstation/tracking/shipment/:shipmentId
 * Get tracking information by shipment ID
 */
router.get('/tracking/shipment/:shipmentId', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const { shipmentId } = req.params;
        const trackingInfo = await shipstationClient.getShipmentTracking(shipmentId);
        
        res.json({
            success: true,
            tracking: trackingInfo
        });
    } catch (error) {
        console.error('Error getting tracking by shipment ID:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get tracking information',
            error: error.message
        });
    }
});

/**
 * GET /api/shipstation/tracking/order/:orderNumber
 * Get tracking information by order number
 */
router.get('/tracking/order/:orderNumber', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const { orderNumber } = req.params;
        const trackingInfo = await shipstationClient.getTrackingByOrderNumber(orderNumber);
        
        res.json({
            success: true,
            tracking: trackingInfo
        });
    } catch (error) {
        console.error('Error getting tracking by order number:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get tracking information',
            error: error.message
        });
    }
});

/**
 * GET /api/shipstation/tracking/tracking-number/:trackingNumber
 * Get tracking information by tracking number
 */
router.get('/tracking/tracking-number/:trackingNumber', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const { trackingNumber } = req.params;
        const trackingInfo = await shipstationClient.getTrackingByTrackingNumber(trackingNumber);
        
        res.json({
            success: true,
            tracking: trackingInfo
        });
    } catch (error) {
        console.error('Error getting tracking by tracking number:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get tracking information',
            error: error.message
        });
    }
});

/**
 * GET /api/shipstation/shipments
 * Get shipments with tracking information
 * Query params: shipment_status, shipment_number, page, page_size, etc.
 *   - use_stream: Enable position tracking to get only new shipments since last call (default: false)
 */
router.get('/shipments', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const usePositionTracking = req.query.use_stream === 'true' || req.query.use_stream === '1';
        const queryParams = { ...req.query };
        delete queryParams.use_stream; // Remove use_stream from query params

        const shipments = await shipstationClient.getShipmentsWithTracking(queryParams, usePositionTracking);
        
        res.json({
            success: true,
            ...shipments
        });
    } catch (error) {
        console.error('Error fetching shipments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch shipments',
            error: error.message
        });
    }
});

/**
 * GET /api/shipstation/fulfillments
 * Get fulfillments (shipped orders with tracking)
 * Query params: shipment_id, shipment_number, tracking_number, etc.
 */
router.get('/fulfillments', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const fulfillments = await shipstationClient.getFulfillments(req.query);
        
        res.json({
            success: true,
            ...fulfillments
        });
    } catch (error) {
        console.error('Error fetching fulfillments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch fulfillments',
            error: error.message
        });
    }
});

/**
 * GET /api/shipstation/shipped-orders
 * Get orders that have been shipped out with complete order and tracking information
 * Returns orders with label_purchased status (labels have been purchased)
 * Query params: 
 *   - shipment_status: Valid statuses include 'label_purchased', 'pending', 'processing', 'cancelled' (default: 'label_purchased')
 *   - ship_date_start: Start date for filtering (ISO 8601)
 *   - ship_date_end: End date for filtering (ISO 8601)
 *   - page: Page number (default: 1)
 *   - page_size: Items per page (default: 50)
 *   - sort_by: Sort field (default: 'modified_at')
 *   - sort_dir: Sort direction 'asc' or 'desc' (default: 'desc')
 *   - use_stream: Enable position tracking to get only new orders since last call (default: false)
 * Note: For fully shipped orders with tracking, consider using /api/shipstation/fulfillments endpoint
 */
router.get('/shipped-orders', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const usePositionTracking = req.query.use_stream === 'true' || req.query.use_stream === '1';
        const queryParams = { ...req.query };
        delete queryParams.use_stream; // Remove use_stream from query params

        const shippedOrders = await shipstationClient.getShippedOrders(queryParams, usePositionTracking);
        
        res.json({
            success: true,
            ...shippedOrders
        });
    } catch (error) {
        console.error('Error fetching shipped orders:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch shipped orders',
            error: error.message
        });
    }
});

/**
 * GET /api/shipstation/shipped-orders/position
 * Get position tracking status for shipped orders
 */
router.get('/shipped-orders/position', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const position = await shipstationClient.getShippedOrdersPosition();
        
        res.json({
            success: true,
            position: position || { message: 'No position tracking data found' }
        });
    } catch (error) {
        console.error('Error getting position:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get position',
            error: error.message
        });
    }
});

/**
 * POST /api/shipstation/shipped-orders/position/reset
 * Reset position tracking for shipped orders
 */
router.post('/shipped-orders/position/reset', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        await shipstationClient.resetShippedOrdersPosition();
        
        res.json({
            success: true,
            message: 'Position tracking reset successfully'
        });
    } catch (error) {
        console.error('Error resetting position:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to reset position',
            error: error.message
        });
    }
});

/**
 * GET /api/shipstation/webhooks
 * List all webhooks
 */
router.get('/webhooks', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const webhooks = await shipstationClient.listWebhooks();
        
        res.json({
            success: true,
            webhooks: webhooks,
            count: webhooks.length
        });
    } catch (error) {
        console.error('Error listing webhooks:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to list webhooks',
            error: error.message
        });
    }
});

/**
 * POST /api/shipstation/webhooks
 * Create a webhook
 * Body: { name, event, url }
 * Events: fulfillment_shipped_v2, label_created_v2, shipment_created_v2, track_event_v2, etc.
 */
router.post('/webhooks', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const { name, event, url } = req.body;

        if (!name || !event || !url) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: name, event, url'
            });
        }

        const webhook = await shipstationClient.createWebhook(name, event, url);
        
        res.json({
            success: true,
            webhook: webhook
        });
    } catch (error) {
        console.error('Error creating webhook:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create webhook',
            error: error.message
        });
    }
});

/**
 * GET /api/shipstation/webhooks/:webhookId
 * Get webhook by ID
 */
router.get('/webhooks/:webhookId', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const { webhookId } = req.params;
        const webhook = await shipstationClient.getWebhook(webhookId);
        
        res.json({
            success: true,
            webhook: webhook
        });
    } catch (error) {
        console.error('Error getting webhook:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get webhook',
            error: error.message
        });
    }
});

/**
 * PUT /api/shipstation/webhooks/:webhookId
 * Update webhook URL
 * Body: { url }
 */
router.put('/webhooks/:webhookId', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const { webhookId } = req.params;
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({
                success: false,
                message: 'Missing required field: url'
            });
        }

        const webhook = await shipstationClient.updateWebhook(webhookId, url);
        
        res.json({
            success: true,
            webhook: webhook
        });
    } catch (error) {
        console.error('Error updating webhook:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update webhook',
            error: error.message
        });
    }
});

/**
 * DELETE /api/shipstation/webhooks/:webhookId
 * Delete webhook
 */
router.delete('/webhooks/:webhookId', async (req, res) => {
    try {
        if (!shipstationClient) {
            return res.status(503).json({
                success: false,
                message: 'ShipStation client not configured'
            });
        }

        const { webhookId } = req.params;
        await shipstationClient.deleteWebhook(webhookId);
        
        res.json({
            success: true,
            message: 'Webhook deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting webhook:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete webhook',
            error: error.message
        });
    }
});

module.exports = router;

