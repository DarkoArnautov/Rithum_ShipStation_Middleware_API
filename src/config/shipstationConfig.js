require('dotenv').config();

const shipstationConfig = {
    apiKey: process.env.SHIPSTATION_API_KEY || '',
    apiSecret: process.env.SHIPSTATION_API_SECRET || '',
    baseUrl: process.env.SHIPSTATION_BASE_URL || 'https://ssapi.shipstation.com',
    syncSchedule: process.env.ORDER_SYNC_SCHEDULE || '*/5 * * * *'
};

// Validation
const validateConfig = () => {
    const errors = [];
    
    if (!shipstationConfig.apiKey) {
        errors.push('SHIPSTATION_API_KEY is required');
    }
    
    if (!shipstationConfig.apiSecret) {
        errors.push('SHIPSTATION_API_SECRET is required');
    }
    
    if (errors.length > 0) {
        throw new Error(`ShipStation configuration errors: ${errors.join(', ')}`);
    }
    
    return true;
};

module.exports = {
    shipstationConfig,
    validateConfig
};

