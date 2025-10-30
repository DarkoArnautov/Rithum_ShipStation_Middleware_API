const axios = require('axios');

class RithumClient {
    constructor(apiUrl, clientId, clientSecret, accountId) {
        this.apiUrl = apiUrl;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.accountId = accountId;
        this.maxRetries = 3;
        this.retryDelay = 1000; // 1 second base delay
        this.accessToken = null;
        this.tokenExpiresAt = 0; // epoch ms
        
        // Create axios instance with default config
        this.client = axios.create({
            baseURL: this.apiUrl,
            timeout: 30000, // 30 seconds
            headers: {
                'Accept': 'application/json'
            }
        });

        // Add request interceptor for authentication
        this.client.interceptors.request.use(
            async (config) => {
                const token = await this.ensureAccessToken();
                config.headers['Authorization'] = `Bearer ${token}`;
                // Set JSON content-type only when sending a body
                if (config.data && !config.headers['Content-Type']) {
                    config.headers['Content-Type'] = 'application/json';
                }
                return config;
            },
            (error) => Promise.reject(error)
        );

        // Add response interceptor for error handling and token refresh on 401
        this.client.interceptors.response.use(
            (response) => response,
            async (error) => {
                const original = error.config;
                if (error.response?.status === 401 && !original?._retried) {
                    try {
                        await this.refreshAccessToken();
                        original._retried = true;
                        return this.client(original);
                    } catch (e) {
                        // fall through to log below
                    }
                }

                console.error('Rithum API Error:', {
                    status: error.response?.status,
                    statusText: error.response?.statusText,
                    data: error.response?.data,
                    url: original?.url
                });
                return Promise.reject(error);
            }
        );
    }

    /**
     * Ensure there is a valid (non-expired) access token.
     */
    async ensureAccessToken() {
        const now = Date.now();
        if (this.accessToken && now < this.tokenExpiresAt) {
            return this.accessToken;
        }
        await this.refreshAccessToken();
        return this.accessToken;
    }

    /**
     * Get a new access token via OAuth2 Client Credentials
     */
    async refreshAccessToken() {
        const tokenUrl = this.normalizeUrl(this.apiUrl, '/oauth2/token');
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', this.clientId);
        params.append('client_secret', this.clientSecret);

        console.log('Getting access token from:', tokenUrl);

        try {
            const response = await axios.post(tokenUrl, params.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000
            });

            const { access_token, expires_in } = response.data || {};
            if (!access_token) {
                throw new Error('Failed to obtain access token');
            }
            
            const bufferSeconds = 60;
            this.accessToken = access_token;
            this.tokenExpiresAt = Date.now() + Math.max(0, (expires_in - bufferSeconds)) * 1000;
            console.log('Access token obtained, expires in:', expires_in, 'seconds');
        } catch (error) {
            console.log('Token request failed:', {
                status: error.response?.status,
                statusText: error.response?.statusText,
                data: error.response?.data,
                message: error.message
            });
            throw error;
        }
    }

    normalizeUrl(base, path) {
        const hasSlash = base.endsWith('/') || path.startsWith('/');
        if (hasSlash) return `${base.replace(/\/$/, '')}${path}`;
        return `${base}/${path}`;
    }

    /**
     * Make API request with retry logic
     * @param {string} method - HTTP method
     * @param {string} endpoint - API endpoint
     * @param {Object} data - Request data
     * @param {Object} params - Query parameters
     * @returns {Promise} API response
     */
    async makeRequest(method, endpoint, data = null, params = null) {
        let lastError;
        
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                const config = {
                    method,
                    url: endpoint,
                    data,
                    params
                };

                console.log(`Rithum API Request (attempt ${attempt}):`, {
                    method,
                    endpoint,
                    hasData: !!data,
                    hasParams: !!params
                });

                const response = await this.client(config);
                
                console.log(`Rithum API Success (attempt ${attempt}):`, {
                    status: response.status,
                    endpoint
                });

                return response.data;
            } catch (error) {
                lastError = error;
                
                // Don't retry on client errors (4xx) except 429 (rate limit)
                if (error.response?.status >= 400 && error.response?.status < 500 && error.response?.status !== 429) {
                    throw error;
                }

                // Don't retry on last attempt
                if (attempt === this.maxRetries) {
                    break;
                }

                // Calculate delay with exponential backoff
                const delay = this.retryDelay * Math.pow(2, attempt - 1);
                console.log(`Rithum API Retry in ${delay}ms (attempt ${attempt}/${this.maxRetries})`);
                
                await this.sleep(delay);
            }
        }

        throw lastError;
    }

    /**
     * Sleep utility function
     * @param {number} ms - Milliseconds to sleep
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Test connection to Rithum API
     * @returns {Promise<Object>} Connection test result
     */
    async testConnection() {
        try {
            console.log('Testing Rithum API connection...');
            // Validate token fetch only (health endpoint may not exist)
            await this.refreshAccessToken();
            return {
                success: true,
                message: 'Access token retrieved successfully',
                expiresAt: this.tokenExpiresAt
            };
        } catch (error) {
            return {
                success: false,
                message: 'Connection failed',
                error: error.message,
                status: error.response?.status
            };
        }
    }

    /**
     * Fetch orders from Rithum API
     * @param {Object} params - Query parameters for orders
     * @returns {Promise<Array>} Array of orders
     */
    async fetchOrders(params = {}) {
        try {
            console.log('Fetching orders from Rithum API...');
            
            // Adjust endpoint based on actual Rithum API documentation
            const response = await this.makeRequest('GET', '/orders', null, params);
            
            console.log(`Fetched ${response.length || 0} orders from Rithum`);
            return response;
        } catch (error) {
            console.error('Error fetching orders from Rithum:', error.message);
            throw error;
        }
    }

    /**
     * Update order status in Rithum
     * @param {string} orderId - Rithum order ID
     * @param {Object} updateData - Data to update
     * @returns {Promise<Object>} Update result
     */
    async updateOrder(orderId, updateData) {
        try {
            console.log(`Updating Rithum order ${orderId}...`);
            
            const response = await this.makeRequest('PUT', `/orders/${orderId}`, updateData);
            
            console.log(`Successfully updated Rithum order ${orderId}`);
            return response;
        } catch (error) {
            console.error(`Error updating Rithum order ${orderId}:`, error.message);
            throw error;
        }
    }
}

module.exports = RithumClient;
