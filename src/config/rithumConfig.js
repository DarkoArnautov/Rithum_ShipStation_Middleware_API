require('dotenv').config();

const rithumConfig = {
    apiUrl: process.env.RITHUM_API_URL || 'https://api.dsco.io/api/v3',
    clientId: process.env.RITHUM_CLIENT_ID || '',
    clientSecret: process.env.RITHUM_CLIENT_SECRET || '',
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
