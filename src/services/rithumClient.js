const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

class RithumClient {
    constructor(apiUrl, clientId, clientSecret) {
        this.apiUrl = apiUrl;
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.maxRetries = 3;
        this.retryDelay = 1000; // 1 second base delay
        this.accessToken = null;
        this.tokenExpiresAt = 0; // epoch ms
        
        // Stream state management
        this.streamConfigFile = path.join(__dirname, '../../.stream-config.json');
        this.streamId = null;
        this.lastPosition = null;
        
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


    /**
     * Fetch orders from Rithum API
     * @param {Object} params - Query parameters for orders
     * @param {string} params.scrollId - Scroll ID for pagination
     * @param {string} params.consumerOrderNumber - Filter by consumer order number
     * @param {string} params.ordersCreatedSince - Orders created since this date (ISO 8601)
     * @param {string} params.ordersUpdatedSince - Orders updated since this date (ISO 8601)
     * @param {string} params.until - End date for search (ISO 8601, must be at least 5 seconds in past)
     * @param {string[]} params.status - Filter by status(es): created, shipment_pending, shipped, cancelled
     * @param {boolean} params.includeTestOrders - Include test orders
     * @param {number} params.ordersPerPage - Orders per page (default 10, max 100)
     * @returns {Promise<Object>} Orders response with pagination
     */
    async fetchOrders(params = {}) {
        try {
            console.log('Fetching orders from Rithum API...');
            
            const response = await this.makeRequest('GET', '/order/page', null, params);
            
            console.log(`Fetched orders page from Rithum, hasScrollId: ${!!response.scrollId}`);
            return response;
        } catch (error) {
            console.error('Error fetching orders from Rithum:', error.message);
            console.error('Response:', error.response?.data);
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

    /**
     * Create an event stream for orders
     * @param {string} description - Description of the stream
     * @returns {Promise<Object>} Created stream object
     */
    async createOrderStream(description = 'Order event stream for new orders') {
        try {
            console.log('Creating order event stream...');
            
            const streamData = {
                objectType: 'order',
                description: description,
                query: {
                    queryType: 'order'
                }
            };
            
            const response = await this.makeRequest('POST', '/stream', streamData);
            
            console.log('Order stream created:', response.id);
            return response;
        } catch (error) {
            console.error('Error creating order stream:', error.message);
            throw error;
        }
    }

    /**
     * Get stream by ID
     * @param {string} streamId - Stream ID
     * @returns {Promise<Object>} Stream object
     */
    async getStream(streamId) {
        try {
            const response = await this.makeRequest('GET', '/stream', null, { id: streamId });
            if (Array.isArray(response) && response.length > 0) {
                return response[0];
            }
            throw new Error(`Stream ${streamId} not found`);
        } catch (error) {
            console.error(`Error getting stream ${streamId}:`, error.message);
            throw error;
        }
    }

    /**
     * Get stream events from a specific position
     * @param {string} streamId - Stream ID
     * @param {number} partitionId - Partition ID (usually 0 for single partition)
     * @param {string} position - Position to start from (use stream's position property)
     * @returns {Promise<Object>} Stream events
     */
    async getStreamEventsFromPosition(streamId, partitionId, position) {
        try {
            console.log(`Getting stream events from position ${position}...`);
            await this.ensureAccessToken();
            const encodedPosition = encodeURIComponent(position);
            const endpoint = `/stream/${streamId}/${partitionId}/${encodedPosition}`;
            
            const response = await this.makeRequest('GET', endpoint);
            return response;
        } catch (error) {
            console.error('Error getting stream events:', error.message);
            throw error;
        }
    }

    /**
     * Load stream configuration from file
     */
    async loadStreamConfig() {
        try {
            const data = await fs.readFile(this.streamConfigFile, 'utf8');
            const config = JSON.parse(data);
            this.streamId = config.streamId;
            this.lastPosition = config.lastPosition;
            return config;
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    /**
     * Save stream configuration to file
     */
    async saveStreamConfig() {
        const config = {
            streamId: this.streamId,
            lastPosition: this.lastPosition,
            updatedAt: new Date().toISOString()
        };
        await fs.writeFile(this.streamConfigFile, JSON.stringify(config, null, 2), 'utf8');
    }

    /**
     * Initialize or get existing order stream with state management
     * @param {string} description - Description for new stream
     * @returns {Promise<Object>} Stream configuration
     */
    async initializeOrderStream(description = 'Order stream for ShipStation integration - new orders') {
        // Try to load existing stream
        const existingConfig = await this.loadStreamConfig();
        
        if (existingConfig && existingConfig.streamId) {
            // Verify stream still exists
            try {
                const stream = await this.getStream(existingConfig.streamId);
                this.streamId = existingConfig.streamId;
                this.lastPosition = existingConfig.lastPosition;
                console.log('Using existing order stream:', this.streamId);
                return stream;
            } catch (error) {
                console.warn('Existing stream not found, creating new one...');
            }
        }

        // Create new stream
        try {
            const stream = await this.createOrderStream(description);
            this.streamId = stream.id;
            this.lastPosition = null; // Start from beginning
            await this.saveStreamConfig();
            console.log('Created new order stream:', this.streamId);
            return stream;
        } catch (error) {
            console.error('Failed to create order stream:', error.message);
            throw error;
        }
    }

    /**
     * Get order by ID
     * @param {string} orderId - Order ID
     * @returns {Promise<Object>} Order details
     */
    async getOrderById(orderId) {
        try {
            const response = await this.makeRequest('GET', `/orders/${orderId}`);
            return response;
        } catch (error) {
            console.error(`Error fetching order ${orderId}:`, error.message);
            throw error;
        }
    }

    /**
     * Check for new orders from stream with state management
     * @param {boolean} includeOrderDetails - Whether to fetch full order details
     * @returns {Promise<Object>} New orders and metadata
     */
    async checkForNewOrders(includeOrderDetails = false) {
        try {
            // Ensure stream is initialized
            if (!this.streamId) {
                await this.initializeOrderStream();
            }

            // Load current position if available
            await this.loadStreamConfig();

            // Get stream to find current position
            const stream = await this.getStream(this.streamId);
            
            if (!stream || !stream.partitions || stream.partitions.length === 0) {
                throw new Error('Stream not found or has no partitions');
            }

            const partition = stream.partitions[0];
            const partitionId = partition.partitionId;
            const currentPosition = this.lastPosition || partition.position || '0';

            console.log(`[checkForNewOrders] Using position: ${currentPosition}`);
            console.log(`[checkForNewOrders] Partition position: ${partition.position}`);
            console.log(`[checkForNewOrders] Config lastPosition: ${this.lastPosition}`);

            // Get events from current position
            const eventsResponse = await this.getStreamEventsFromPosition(
                this.streamId,
                partitionId,
                currentPosition
            );
            
            console.log(`[checkForNewOrders] Received ${(eventsResponse.events || []).length} events`);

            // Get all events for display
            const allEvents = eventsResponse.events || [];

            // Filter for create events (new orders)
            // Note: eventReasons is an array, and order ID is in payload.dscoOrderId
            const newOrderEvents = allEvents.filter(
                event => event.eventReasons && event.eventReasons.includes('create')
            );

            // Extract order IDs from create events
            const newOrderIds = newOrderEvents.map(event => {
                // Order ID is in payload.dscoOrderId
                return event.payload?.dscoOrderId || event.objectId || null;
            }).filter(id => id !== null);

            // Get order details from event payloads (already included in stream events)
            // This avoids making separate API calls which may result in 403 errors
            let orderDetails = [];
            if (includeOrderDetails && newOrderEvents.length > 0) {
                try {
                    // Extract order data directly from event payloads
                    orderDetails = newOrderEvents.map(event => {
                        const orderId = event.payload?.dscoOrderId || event.objectId || null;
                        if (event.payload) {
                            // Return the full order payload with the order ID
                            return {
                                id: orderId,
                                ...event.payload
                            };
                        } else {
                            // Fallback: if payload is missing, try to fetch via API
                            return { id: orderId, error: 'Payload not available in event' };
                        }
                    });
                } catch (error) {
                    console.error('Error extracting order details from events:', error.message);
                    // Fallback to API fetching if payload extraction fails
                    if (newOrderIds.length > 0) {
                        try {
                            const orderPromises = newOrderIds.map(orderId => 
                                this.getOrderById(orderId).catch(error => {
                                    console.warn(`Failed to fetch order ${orderId}:`, error.message);
                                    return { id: orderId, error: error.message };
                                })
                            );
                            orderDetails = await Promise.all(orderPromises);
                        } catch (fetchError) {
                            console.error('Error fetching order details via API:', fetchError.message);
                        }
                    }
                }
            }

            // Update last position after processing events
            // Use the last event's ID as the new position marker (event IDs are position markers)
            let newPosition = currentPosition;
            if (allEvents.length > 0) {
                // Get the last event's ID to use as the new position
                const lastEvent = allEvents[allEvents.length - 1];
                if (lastEvent && lastEvent.id) {
                    newPosition = lastEvent.id;
                    console.log(`[checkForNewOrders] Updating position to last event ID: ${newPosition}`);
                } else {
                    // Fallback: try to get updated partition position
                    try {
                        const updatedStream = await this.getStream(this.streamId);
                        if (updatedStream && updatedStream.partitions && updatedStream.partitions.length > 0) {
                            const updatedPartition = updatedStream.partitions.find(p => p.partitionId === partitionId);
                            if (updatedPartition && updatedPartition.position) {
                                newPosition = updatedPartition.position;
                                console.log(`[checkForNewOrders] Using partition position: ${newPosition}`);
                            }
                        }
                        // Check if response has a position field
                        if (newPosition === currentPosition && eventsResponse.position) {
                            newPosition = eventsResponse.position;
                            console.log(`[checkForNewOrders] Using response position: ${newPosition}`);
                        }
                    } catch (error) {
                        console.warn('Could not fetch updated partition position:', error.message);
                        // Keep current position if we can't get updated one
                    }
                }
            }

            // Always update position if we processed events (to avoid re-processing)
            if (newPosition && newPosition !== this.lastPosition) {
                this.lastPosition = newPosition;
                await this.saveStreamConfig();
                console.log(`[checkForNewOrders] Position saved: ${newPosition}`);
            } else if (allEvents.length === 0) {
                console.log(`[checkForNewOrders] No events found, position unchanged: ${currentPosition}`);
            }

            // Format events for response (for backward compatibility and display)
            const formattedEvents = newOrderEvents.map(event => ({
                eventReason: event.eventReasons?.[0] || 'create',
                objectId: event.payload?.dscoOrderId || event.objectId,
                id: event.id,
                payload: event.payload
            }));

            const formattedAllEvents = allEvents.map(event => ({
                eventReason: event.eventReasons?.[0] || 'unknown',
                objectId: event.payload?.dscoOrderId || event.objectId,
                id: event.id,
                payload: event.payload
            }));

            return {
                success: true,
                newOrderCount: newOrderEvents.length,
                newOrderIds: newOrderIds,
                events: formattedEvents,
                allEvents: formattedAllEvents, // Include all events for visibility
                orderDetails: orderDetails,
                lastPosition: this.lastPosition,
                streamId: this.streamId
            };
        } catch (error) {
            console.error('Error checking for new orders:', error.message);
            return {
                success: false,
                error: error.message,
                newOrderCount: 0,
                newOrderIds: [],
                events: [],
                allEvents: []
            };
        }
    }

    /**
     * Get stream status with state
     * @returns {Promise<Object>} Stream status
     */
    async getOrderStreamStatus() {
        try {
            await this.loadStreamConfig();
            if (!this.streamId) {
                return {
                    initialized: false,
                    message: 'Stream not initialized. Call initializeOrderStream() first.'
                };
            }

            const stream = await this.getStream(this.streamId);
            return {
                initialized: true,
                streamId: this.streamId,
                lastPosition: this.lastPosition,
                stream: {
                    id: stream.id,
                    description: stream.description,
                    objectType: stream.objectType,
                    partitions: stream.partitions?.map(p => ({
                        partitionId: p.partitionId,
                        position: p.position,
                        status: p.status
                    }))
                }
            };
        } catch (error) {
            return {
                initialized: false,
                error: error.message
            };
        }
    }
}

module.exports = RithumClient;
