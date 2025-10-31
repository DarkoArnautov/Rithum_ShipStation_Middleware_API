require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Import routes
const rithumRoutes = require('./routes/rithum');
const shipstationRoutes = require('./routes/shipstation');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/rithum', rithumRoutes);
app.use('/api/shipstation', shipstationRoutes);

// Health check routes
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'Rithum-ShipStation Middleware' 
    });
});

// Root endpoint - API documentation
app.get('/', (req, res) => {
    res.json({
        message: 'Rithum-ShipStation Middleware API',
        status: 'running',
        version: '1.0.0',
        endpoints: {
            health: '/ping',
            rithum: {
                base: '/api/rithum',
                token: '/api/rithum/token',
                orders: 'GET /api/rithum/orders',
                updateOrder: 'PUT /api/rithum/orders/:id',
                status: '/api/rithum/status',
                streamInitialize: 'POST /api/rithum/stream/initialize',
                streamStatus: '/api/rithum/stream/status',
                newOrders: '/api/rithum/stream/new-orders'
            },
            shipstation: {
                base: '/api/shipstation',
                ping: '/api/shipstation/ping',
                test: '/api/shipstation/test',
                status: '/api/shipstation/status',
                webhook: 'POST /api/shipstation/webhooks/order-notify'
            }
        }
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Route not found'
    });
});

// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
