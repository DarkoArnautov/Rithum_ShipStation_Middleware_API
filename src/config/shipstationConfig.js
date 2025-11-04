require('dotenv').config();


let baseUrl = process.env.SHIPSTATION_BASE_URL || process.env.SHIPSTATION_API_URL || 'https://api.shipstation.com';
// Remove trailing /v2/ if present
baseUrl = baseUrl.replace(/\/v2\/?$/, '');

// Parse ship_from address from environment if provided
let shipFromAddress = null;
if (process.env.SHIPSTATION_SHIP_FROM_NAME || process.env.SHIPSTATION_SHIP_FROM_ADDRESS) {
    shipFromAddress = {
        name: process.env.SHIPSTATION_SHIP_FROM_NAME || '',
        company_name: process.env.SHIPSTATION_SHIP_FROM_COMPANY || null,
        phone: process.env.SHIPSTATION_SHIP_FROM_PHONE || '',
        address_line1: process.env.SHIPSTATION_SHIP_FROM_ADDRESS || '',
        address_line2: process.env.SHIPSTATION_SHIP_FROM_ADDRESS2 || null,
        city_locality: process.env.SHIPSTATION_SHIP_FROM_CITY || '',
        state_province: process.env.SHIPSTATION_SHIP_FROM_STATE || '',
        postal_code: process.env.SHIPSTATION_SHIP_FROM_POSTAL || '',
        country_code: process.env.SHIPSTATION_SHIP_FROM_COUNTRY || 'US'
    };
    // Remove null/empty values
    Object.keys(shipFromAddress).forEach(key => {
        if (shipFromAddress[key] === null || shipFromAddress[key] === '') {
            delete shipFromAddress[key];
        }
    });
}

const shipstationConfig = {
    apiKey: process.env.SHIPSTATION_API_KEY || '',
    baseUrl: baseUrl,
    warehouseId: process.env.SHIPSTATION_WAREHOUSE_ID || null,
    shipFrom: shipFromAddress,
    syncSchedule: process.env.ORDER_SYNC_SCHEDULE || '*/5 * * * *'
};

// Validation
const validateConfig = () => {
    const errors = [];
    
    if (!shipstationConfig.apiKey) {
        errors.push('SHIPSTATION_API_KEY is required');
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

