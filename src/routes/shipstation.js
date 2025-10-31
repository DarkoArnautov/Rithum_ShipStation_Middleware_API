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
        shipstationConfig.apiSecret,
        shipstationConfig.baseUrl
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
 * Webhook endpoint for ShipStation order notifications
 * ShipStation sends notifications when orders are shipped, cancelled, etc.
 */
router.post('/webhooks/order-notify', async (req, res) => {
    try {
        console.log('Received ShipStation webhook:', req.body);

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

        const orderIdMatch = resource_url.match(/\/orders\/(\d+)/);
        
        if (!orderIdMatch) {
            return res.status(400).json({
                success: false,
                message: 'Could not extract order ID from resource_url'
            });
        }

        const shipstationOrderId = orderIdMatch[1];
        const order = await shipstationClient.getOrderById(shipstationOrderId);

        console.log('Processing ShipStation order update:', {
            orderId: shipstationOrderId,
            orderNumber: order.orderNumber,
            orderStatus: order.orderStatus
        });

        // Update Rithum with tracking information if order is shipped
        if (order.orderStatus === 'shipped' && order.shipments && order.shipments.length > 0) {
            await updateRithumWithTracking(order);
        }

        res.json({
            success: true,
            message: 'Webhook processed successfully',
            orderId: shipstationOrderId
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
 * Update Rithum order with tracking information from ShipStation
 * @param {Object} shipstationOrder - ShipStation order object
 */
async function updateRithumWithTracking(shipstationOrder) {
    try {
        if (!rithumClient) {
            console.warn('Rithum client not available, skipping tracking update');
            return;
        }

        // Extract Rithum order ID from ShipStation order (stored in customField2)
        const rithumOrderId = shipstationOrder.advancedOptions?.customField2 || 
                             shipstationOrder.customField2;

        if (!rithumOrderId) {
            console.warn('Could not find Rithum order ID in ShipStation order');
            return;
        }

        // Process each shipment
        for (const shipment of shipstationOrder.shipments || []) {
            const trackingNumber = shipment.trackingNumber;
            const carrier = shipment.carrierCode;
            const shipDate = shipment.shipDate;

            if (!trackingNumber) {
                continue;
            }

            console.log(`Updating Rithum order ${rithumOrderId} with tracking:`, {
                trackingNumber,
                carrier,
                shipDate
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
        }

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
        hasApiSecret: !!shipstationConfig.apiSecret
    });
});

module.exports = router;

