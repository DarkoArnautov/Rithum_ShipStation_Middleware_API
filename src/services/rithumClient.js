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

    async ensureAccessToken() {
        const now = Date.now();
        if (this.accessToken && now < this.tokenExpiresAt) {
            return this.accessToken;
        }
        await this.refreshAccessToken();
        return this.accessToken;
    }

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

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

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

    async createShipments(orderShipments) {
        try {
            const payload = Array.isArray(orderShipments) ? orderShipments : [orderShipments];
            console.log(`Submitting shipment batch to Rithum (orders: ${payload.length})...`);
            const response = await this.makeRequest('POST', '/order/shipment/batch/small', payload);
            console.log('Successfully submitted shipment batch to Rithum');
            return response;
        } catch (error) {
            console.error('Error submitting shipments to Rithum:', error.message);
            throw error;
        }
    }

    async submitOrderUpdates(updates) {
        try {
            const payload = Array.isArray(updates) ? updates : [updates];
            console.log(`Submitting order update batch to Rithum (updates: ${payload.length})...`);
            const response = await this.makeRequest('POST', '/orderupdate/batch/small', payload);
            console.log('Successfully submitted order update batch to Rithum');
            return response;
        } catch (error) {
            console.error('Error submitting order updates to Rithum:', error.message);
            throw error;
        }
    }

    async createOrder(order) {
        try {
            console.log(`Creating single order on Rithum (poNumber: ${order.poNumber})...`);
            const response = await this.makeRequest('POST', '/order/', order);
            console.log(`Successfully created order (poNumber: ${order.poNumber})`);
            return response;
        } catch (error) {
            console.error(`Error creating order (poNumber: ${order.poNumber}):`, error.message);
            throw error;
        }
    }

    async createOrdersBatch(orders) {
        try {
            const payload = Array.isArray(orders) ? orders : [orders];
            console.log(`Creating order batch on Rithum (orders: ${payload.length})...`);
            const response = await this.makeRequest('POST', '/order/batch/small', payload);
            
            // Log response details for debugging
            if (response.requestId) {
                console.log(`✅ Successfully submitted order batch to Rithum (requestId: ${response.requestId})`);
            } else {
                console.log(`⚠️  Order batch response received but no requestId found`);
                console.log(`   Response status: ${response.status || 'unknown'}`);
            }
            
            // Log any messages or errors in the response
            if (response.messages && response.messages.length > 0) {
                console.log(`   Response contains ${response.messages.length} message(s):`);
                response.messages.forEach((msg, index) => {
                    console.log(`     ${index + 1}. [${msg.severity || 'info'}] ${msg.code || 'N/A'}: ${msg.description || 'N/A'}`);
                });
            }
            
            return response;
        } catch (error) {
            console.error('Error creating order batch on Rithum:', error.message);
            if (error.response && error.response.data) {
                console.error('   Error response:', JSON.stringify(error.response.data, null, 2));
            }
            throw error;
        }
    }

    async getOrderChangeLog(params = {}) {
        try {
            console.log('Fetching Rithum order change log...', params);
            const response = await this.makeRequest('GET', '/order/changelog', null, params);
            return response;
        } catch (error) {
            console.error('Error fetching order change log:', error.message);
            throw error;
        }
    }

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

    async saveStreamConfig() {
        const config = {
            streamId: this.streamId,
            lastPosition: this.lastPosition,
            updatedAt: new Date().toISOString()
        };
        await fs.writeFile(this.streamConfigFile, JSON.stringify(config, null, 2), 'utf8');
    }

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

    async getOrderById(orderId, options = {}) {
        const {
            orderKey = 'dscoOrderId',
            include = ['lineItems', 'shipping', 'shipTo', 'billTo'],
            additionalParams = {}
        } = options;

        const params = {
            orderKey,
            value: orderId,
            ...additionalParams
        };

        if (include && include.length > 0) {
            params.include = Array.isArray(include) ? include.join(',') : include;
        }

        try {
            const response = await this.makeRequest('GET', '/orders', null, params);

            if (Array.isArray(response)) {
                if (response.length === 0) {
                    throw new Error(`Order ${orderId} not found`);
                }
                return response[0];
            }

            if (response?.order) {
                return response.order;
            }

            return response;
        } catch (error) {
            if (error.response?.status === 404) {
                console.error(`Order ${orderId} not found (404)`);
            } else {
                console.error(`Error fetching order ${orderId}:`, error.message);
            }
            throw error;
        }
    }

    async checkForNewOrders(includeOrderDetails = false, dscoLifecycleFilter = null, eventReasonsFilter = ['create']) {
        try {
            if (!this.streamId) {
                await this.initializeOrderStream();
            }

            await this.loadStreamConfig();

            const stream = await this.getStream(this.streamId);
            
            if (!stream || !stream.partitions || stream.partitions.length === 0) {
                throw new Error('Stream not found or has no partitions');
            }

            const partition = stream.partitions[0];
            const partitionId = partition.partitionId;
            const currentPosition = this.lastPosition || partition.position || '0';

            console.log(`[checkForNewOrders] Using position: ${currentPosition}`);
            if (dscoLifecycleFilter) {
                console.log(`[checkForNewOrders] Filtering by dscoLifecycle: ${dscoLifecycleFilter}`);
            }
            if (eventReasonsFilter && eventReasonsFilter.length > 0) {
                console.log(`[checkForNewOrders] Filtering by eventReasons: ${eventReasonsFilter.join(', ')}`);
            }

            const eventsResponse = await this.getStreamEventsFromPosition(
                this.streamId,
                partitionId,
                currentPosition
            );
            
            console.log(`[checkForNewOrders] Received ${(eventsResponse.events || []).length} events`);

            const allEvents = eventsResponse.events || [];

            // Filter events based on eventReasons and dscoLifecycle status
            let newOrderEvents = allEvents.filter(event => {
                // Check event reasons filter (e.g., 'create', 'update_status_lifecycle')
                const hasMatchingReason = event.eventReasons && 
                    event.eventReasons.some(reason => eventReasonsFilter.includes(reason));
                
                if (!hasMatchingReason) {
                    return false;
                }

                // Apply lifecycle status filter if provided
                if (dscoLifecycleFilter) {
                    const payload = event.payload;
                    return payload && payload.dscoLifecycle === dscoLifecycleFilter;
                }

                return true;
            });

            const newOrderIds = newOrderEvents.map(event => {
                return event.payload?.dscoOrderId || event.objectId || null;
            }).filter(id => id !== null);

            let orderDetails = [];
            if (includeOrderDetails && newOrderEvents.length > 0) {
                orderDetails = [];
                for (const event of newOrderEvents) {
                    const orderId = event.payload?.dscoOrderId || event.objectId || null;
                    let detail = null;

                    if (event.payload) {
                        detail = {
                            id: orderId,
                            ...event.payload
                        };
                    }

                    const needsFullFetch = !detail || !Array.isArray(detail.lineItems) || detail.lineItems.length === 0;

                    if (needsFullFetch && orderId) {
                        try {
                            const fetchedOrder = await this.getOrderById(orderId, {
                                include: ['lineItems', 'shipping', 'shipTo', 'billTo']
                            });
                            detail = {
                                id: orderId,
                                ...fetchedOrder
                            };
                        } catch (fetchError) {
                            console.error(`Error fetching order ${orderId} details:`, fetchError.message);
                            detail = detail || { id: orderId };
                            detail.fetchError = fetchError.message;
                        }
                    }

                    if (!detail) {
                        detail = {
                            id: orderId,
                            error: 'Payload not available in event'
                        };
                    }

                    orderDetails.push(detail);
                }
            }
            let newPosition = currentPosition;
            if (allEvents.length > 0) {
                const lastEvent = allEvents[allEvents.length - 1];
                if (lastEvent && lastEvent.id) {
                    newPosition = lastEvent.id;
                    console.log(`[checkForNewOrders] Updating position to last event ID: ${newPosition}`);
                } else {
                    try {
                        const updatedStream = await this.getStream(this.streamId);
                        if (updatedStream && updatedStream.partitions && updatedStream.partitions.length > 0) {
                            const updatedPartition = updatedStream.partitions.find(p => p.partitionId === partitionId);
                            if (updatedPartition && updatedPartition.position) {
                                newPosition = updatedPartition.position;
                                console.log(`[checkForNewOrders] Using partition position: ${newPosition}`);
                            }
                        }
                        if (newPosition === currentPosition && eventsResponse.position) {
                            newPosition = eventsResponse.position;
                            console.log(`[checkForNewOrders] Using response position: ${newPosition}`);
                        }
                    } catch (error) {
                        console.warn('Could not fetch updated partition position:', error.message);
                    }
                }
            }

            if (newPosition && newPosition !== this.lastPosition) {
                this.lastPosition = newPosition;
                await this.saveStreamConfig();
                console.log(`[checkForNewOrders] Position saved: ${newPosition}`);
            } else if (allEvents.length === 0) {
                console.log(`[checkForNewOrders] No events found, position unchanged: ${currentPosition}`);
            }

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

