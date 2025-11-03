const express = require('express');
const RithumClient = require('../services/rithumClient');
const { rithumConfig, validateConfig } = require('../config/rithumConfig');

const router = express.Router();

// Initialize Rithum client
let rithumClient = null;

try {
    validateConfig();
    rithumClient = new RithumClient(
        rithumConfig.apiUrl,
        rithumConfig.clientId,
        rithumConfig.clientSecret,
    );
} catch (error) {
    console.warn('Rithum client not initialized:', error.message);
}
/**
 * GET /api/rithum/token
 * Get token status (masked)
 */
router.get('/token', async (req, res) => {
    try {
        if (!rithumClient) {
            return res.status(503).json({
                success: false,
                message: 'Rithum client not configured',
                error: 'Missing OAuth2 credentials (Client ID, Secret Key)'
            });
        }
        await rithumClient.ensureAccessToken();
        const secondsLeft = Math.max(0, Math.floor((rithumClient.tokenExpiresAt - Date.now()) / 1000));
        res.json({
            success: true,
            tokenPresent: !!rithumClient.accessToken,
            expiresAt: rithumClient.tokenExpiresAt,
            secondsLeft
        });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to fetch token', error: error.message });
    }
});


/**
 * GET /api/rithum/orders
 * Fetch orders from Rithum API
 */
router.get('/orders', async (req, res) => {
    try {
        if (!rithumClient) {
            return res.status(503).json({
                success: false,
                message: 'Rithum client not configured',
                error: 'Missing OAuth2 credentials (Client ID, Secret Key)'
            });
        }

        const result = await rithumClient.fetchOrders(req.query);
        
        res.json({
            success: true,
            message: `Fetched ${result.orders?.length || 0} orders`,
            data: result.orders || [],
            pagination: {
                scrollId: result.scrollId || null,
                hasMore: !!result.scrollId,
                totalCount: result.orders?.length || 0
            },
            count: result.orders?.length || 0
        });
    } catch (error) {
        console.error('Error fetching Rithum orders:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch orders',
            error: error.message
        });
    }
});

/**
 * PUT /api/rithum/orders/:id
 * Update order in Rithum
 */
router.put('/orders/:id', async (req, res) => {
    try {
        if (!rithumClient) {
            return res.status(503).json({
                success: false,
                message: 'Rithum client not configured',
                error: 'Missing OAuth2 credentials (Client ID, Secret Key)'
            });
        }

        const { id } = req.params;
        const updateData = req.body;

        const result = await rithumClient.updateOrder(id, updateData);
        
        res.json({
            success: true,
            message: `Order ${id} updated successfully`,
            data: result
        });
    } catch (error) {
        console.error(`Error updating Rithum order ${req.params.id}:`, error);
        res.status(500).json({
            success: false,
            message: 'Failed to update order',
            error: error.message
        });
    }
});

/**
 * GET /api/rithum/status
 * Get Rithum client status
 */
router.get('/status', (req, res) => {
    res.json({
        configured: !!rithumClient,
        apiUrl: rithumConfig.apiUrl,
        hasClientId: !!rithumConfig.clientId,
        hasClientSecret: !!rithumConfig.clientSecret,
    });
});



/**
 * POST /api/rithum/stream/initialize
 * Initialize or create order event stream for detecting new orders
 */
router.post('/stream/initialize', async (req, res) => {
    try {
        if (!rithumClient) {
            return res.status(503).json({
                success: false,
                message: 'Rithum client not configured',
                error: 'Missing OAuth2 credentials'
            });
        }

        const stream = await rithumClient.initializeOrderStream();
        
        res.json({
            success: true,
            message: 'Order stream initialized successfully',
            stream: {
                id: stream.id,
                description: stream.description,
                objectType: stream.objectType
            }
        });
    } catch (error) {
        console.error('Error initializing order stream:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to initialize order stream',
            error: error.message
        });
    }
});

/**
 * GET /api/rithum/stream/status
 * Get order stream status
 */
router.get('/stream/status', async (req, res) => {
    try {
        if (!rithumClient) {
            return res.status(503).json({
                success: false,
                message: 'Rithum client not configured'
            });
        }

        const status = await rithumClient.getOrderStreamStatus();
        res.json(status);
    } catch (error) {
        console.error('Error getting stream status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get stream status',
            error: error.message
        });
    }
});

/**
 * GET /api/rithum/stream/new-orders
 * Check for new orders from the event stream
 * Query params:
 *   - includeDetails: boolean (default: true) - Include full order details
 *   - showAllEvents: boolean (default: false) - Show all events, not just create events
 */
router.get('/stream/new-orders', async (req, res) => {
    try {
        if (!rithumClient) {
            return res.status(503).json({
                success: false,
                message: 'Rithum client not configured'
            });
        }

        const includeDetails = req.query.includeDetails !== 'false'; // Default to true
        const showAllEvents = req.query.showAllEvents === 'true'; // Default to false

        const result = await rithumClient.checkForNewOrders(includeDetails);
        
        // Build response
        const response = {
            success: result.success,
            message: result.success 
                ? `Found ${result.newOrderCount} new order(s)`
                : 'Failed to check for new orders',
            newOrderCount: result.newOrderCount || 0,
            newOrderIds: result.newOrderIds || [],
            streamId: result.streamId,
            lastPosition: result.lastPosition,
            error: result.error
        };

        // Include events
        if (showAllEvents) {
            response.allEvents = result.allEvents || [];
            response.eventsSummary = {
                total: result.allEvents?.length || 0,
                create: result.allEvents?.filter(e => e.eventReason === 'create').length || 0,
                update: result.allEvents?.filter(e => e.eventReason === 'update').length || 0,
                delete: result.allEvents?.filter(e => e.eventReason === 'delete').length || 0
            };
        } else {
            response.events = result.events || [];
        }

        // Include order details if available
        if (result.orderDetails && result.orderDetails.length > 0) {
            response.orders = result.orderDetails;
        }

        res.json(response);
    } catch (error) {
        console.error('Error checking for new orders:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check for new orders',
            error: error.message
        });
    }
});

module.exports = router;
