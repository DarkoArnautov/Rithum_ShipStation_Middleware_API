const axios = require('axios');

/**
 * ShipStation API Client
 */
class ShipStationClient {
    constructor(apiKey, apiSecret, baseUrl = 'https://ssapi.shipstation.com') {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.baseUrl = baseUrl;
        
        // Create axios instance with authentication
        this.client = axios.create({
            baseURL: this.baseUrl,
            timeout: 30000,
            auth: {
                username: this.apiKey,
                password: this.apiSecret
            },
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });
    }

    /**
     * Create an order in ShipStation
     * @param {Object} orderData - Order data in ShipStation format
     * @returns {Promise<Object>} Created order response
     */
    async createOrder(orderData) {
        try {
            console.log('Creating order in ShipStation:', orderData.orderNumber);
            const response = await this.client.post('/orders/createorder', orderData);
            console.log('Order created in ShipStation:', response.data);
            return response.data;
        } catch (error) {
            console.error('Error creating order in ShipStation:', {
                status: error.response?.status,
                data: error.response?.data,
                orderNumber: orderData.orderNumber
            });
            throw error;
        }
    }

    /**
     * Get order by ID
     * @param {string} orderId - ShipStation order ID
     * @returns {Promise<Object>} Order data
     */
    async getOrderById(orderId) {
        try {
            const response = await this.client.get(`/orders/${orderId}`);
            return response.data;
        } catch (error) {
            console.error('Error getting order from ShipStation:', error.message);
            throw error;
        }
    }

    /**
     * Test connection to ShipStation
     * @returns {Promise<Object>} Test result
     */
    async testConnection() {
        try {
            const response = await this.client.get('/orders', { params: { pageSize: 1 } });
            return {
                success: true,
                message: 'ShipStation connection successful'
            };
        } catch (error) {
            return {
                success: false,
                message: 'ShipStation connection failed',
                error: error.message,
                status: error.response?.status
            };
        }
    }
}

module.exports = ShipStationClient;

