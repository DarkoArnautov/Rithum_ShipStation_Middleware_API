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
        rithumConfig.accountId
    );
} catch (error) {
    console.warn('Rithum client not initialized:', error.message);
}

/**
 * GET /api/rithum/test
 * Test connection to Rithum API
 */
router.get('/test', async (req, res) => {
    try {
        if (!rithumClient) {
            return res.status(503).json({
                success: false,
                message: 'Rithum client not configured',
                error: 'Missing OAuth2 credentials (Client ID, Secret Key, Account ID)'
            });
        }

        const result = await rithumClient.testConnection();
        
        if (result.success) {
            res.json(result);
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        console.error('Rithum test connection error:', error);
        res.status(500).json({
            success: false,
            message: 'Test connection failed',
            error: error.message
        });
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
                error: 'Missing OAuth2 credentials (Client ID, Secret Key, Account ID)'
            });
        }

        const orders = await rithumClient.fetchOrders(req.query);
        
        res.json({
            success: true,
            message: `Fetched ${orders.length} orders`,
            data: orders,
            count: orders.length
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
                error: 'Missing OAuth2 credentials (Client ID, Secret Key, Account ID)'
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
        hasAccountId: !!rithumConfig.accountId
    });
});

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
                error: 'Missing OAuth2 credentials (Client ID, Secret Key, Account ID)'
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

module.exports = router;
