require('dotenv').config();

const rithumConfig = {
    apiUrl: process.env.RITHUM_API_URL || 'https://api.dsco.io/api/v3',
    clientId: process.env.RITHUM_CLIENT_ID || '',
    clientSecret: process.env.RITHUM_CLIENT_SECRET || '',
    accountId: process.env.RITHUM_ACCOUNT_ID || '',
    timeout: parseInt(process.env.RITHUM_TIMEOUT) || 30000,
    maxRetries: parseInt(process.env.RITHUM_MAX_RETRIES) || 3,
    retryDelay: parseInt(process.env.RITHUM_RETRY_DELAY) || 1000,
    endpoints: {
        token: '/oauth2/token',
        orders: '/orders',
        orderUpdate: '/orders/:id',
        sync: '/sync'
    }
};

// Validation
const validateConfig = () => {
    const errors = [];
    
    if (!rithumConfig.clientId) {
        errors.push('RITHUM_CLIENT_ID is required');
    }
    
    if (!rithumConfig.clientSecret) {
        errors.push('RITHUM_CLIENT_SECRET is required');
    }
    
    if (errors.length > 0) {
        throw new Error(`Rithum configuration errors: ${errors.join(', ')}`);
    }
    
    return true;
};

module.exports = {
    rithumConfig,
    validateConfig
};
