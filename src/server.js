require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Import routes
const rithumRoutes = require('./routes/rithum');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api/rithum', rithumRoutes);

// Health check routes
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'Rithum-ShipStation Middleware' 
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Rithum-ShipStation Middleware API',
        status: 'running',
        version: '1.0.0',
        endpoints: {
            health: '/ping',
            rithum: '/api/rithum',
            rithumTest: '/api/rithum/test',
            rithumOrders: '/api/rithum/orders',
            rithumStatus: '/api/rithum/status'
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
