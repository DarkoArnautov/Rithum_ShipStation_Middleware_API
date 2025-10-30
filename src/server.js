require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
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
        version: '1.0.0'
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
