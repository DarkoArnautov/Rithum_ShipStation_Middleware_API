const axios = require('axios');

/**
 * ShipStation API Client
 */
class ShipStationClient {
    constructor(apiKey, baseUrl = 'https://api.shipstation.com', warehouseId = null, shipFrom = null) {
        this.apiKey = apiKey;
        this.warehouseId = warehouseId;
        this.shipFrom = shipFrom;
        // Ensure baseUrl doesn't have trailing /v2/ (endpoints will add it)
        this.baseUrl = baseUrl.replace(/\/v2\/?$/, '');
        
        // Create axios instance with authentication
        // ShipStation API v2 uses api-key header (per OpenAPI spec)
        this.client = axios.create({
            baseURL: this.baseUrl,
            timeout: 30000,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'api-key': this.apiKey
            }
        });
    }

    /**
     * Convert v2 format order to v1 format for ShipStation v1 API
     * @param {Object} v2Order - Order in v2 format
     * @returns {Object} Order in v1 format
     */
    convertV2ToV1Format(v2Order) {
        const v1Order = {
            orderNumber: v2Order.orderNumber,
            orderDate: v2Order.orderDate,
            orderStatus: v2Order.orderStatus,
            amountPaid: v2Order.amountPaid || 0,
            currencyCode: v2Order.currencyCode || 'USD',
            customerUsername: v2Order.customerUsername
        };

        // Convert v2 address format to v1 format
        if (v2Order.shipTo) {
            v1Order.shipTo = {
                name: v2Order.shipTo.name,
                street1: v2Order.shipTo.address_line1,
                city: v2Order.shipTo.city_locality,
                state: v2Order.shipTo.state_province,
                postalCode: v2Order.shipTo.postal_code,
                country: v2Order.shipTo.country_code
            };

            if (v2Order.shipTo.address_line2) {
                v1Order.shipTo.street2 = v2Order.shipTo.address_line2;
            }

            if (v2Order.shipTo.phone) {
                v1Order.shipTo.phone = v2Order.shipTo.phone;
            }

            if (v2Order.shipTo.email) {
                v1Order.shipTo.email = v2Order.shipTo.email;
            }

            if (v2Order.shipTo.company_name) {
                v1Order.shipTo.companyName = v2Order.shipTo.company_name;
            }
        }

        // Convert items (v2 format is compatible with v1)
        if (v2Order.items && Array.isArray(v2Order.items)) {
            v1Order.items = v2Order.items;
        }

        // Copy optional fields
        if (v2Order.shipByDate) {
            v1Order.shipByDate = v2Order.shipByDate;
        }

        if (v2Order.orderKey) {
            v1Order.orderKey = v2Order.orderKey;
        }

        if (v2Order.customField1) {
            v1Order.customField1 = v2Order.customField1;
        }

        if (v2Order.customField2) {
            v1Order.customField2 = v2Order.customField2;
        }

        if (v2Order.advancedOptions) {
            v1Order.advancedOptions = v2Order.advancedOptions;
        }

        return v1Order;
    }

    /**
     * Convert order data to shipment format for v2 API
     * @param {Object} orderData - Order data in ShipStation format
     * @returns {Object} Shipment data for v2 API
     */
    convertOrderToShipment(orderData) {
        const shipment = {
            create_sales_order: true, // This creates an order in ShipStation
            shipment_number: orderData.orderNumber,
            external_shipment_id: orderData.orderNumber,
            ship_to: orderData.shipTo,
            items: orderData.items || []
        };

        // Note: Shipments require either warehouse_id or ship_from address
        // For order creation, we'll let ShipStation use default warehouse if available
        // If you have a warehouse_id, you can add it to the order data
        
        // Add optional fields
        if (orderData.amountPaid !== undefined && orderData.amountPaid !== null) {
            shipment.amount_paid = {
                amount: parseFloat(orderData.amountPaid) || 0,
                currency: orderData.currencyCode || 'USD'
            };
        }

        if (orderData.shipByDate) {
            shipment.ship_date = orderData.shipByDate;
        }

        // Add ship_from address if provided (per OpenAPI spec: either ship_from OR warehouse_id must be set)
        // ship_from is sufficient - warehouse_id is optional
        if (this.shipFrom) {
            shipment.ship_from = this.shipFrom;
        } else if (orderData.shipFrom) {
            shipment.ship_from = orderData.shipFrom;
        }

        // Add warehouse_id if provided (only if ship_from is not set, per OpenAPI spec)
        // Note: OpenAPI spec says "Either warehouse_id or ship_from must be specified"
        if (!shipment.ship_from) {
            if (this.warehouseId) {
                shipment.warehouse_id = this.warehouseId;
            } else if (orderData.warehouse_id) {
                shipment.warehouse_id = orderData.warehouse_id;
            } else if (orderData.advancedOptions && orderData.advancedOptions.warehouseId) {
                shipment.warehouse_id = orderData.advancedOptions.warehouseId;
            }
        }

        // Add custom fields as tags (tags must be objects with name property)
        if (orderData.customField1 || orderData.customField2) {
            shipment.tags = [];
            if (orderData.customField1) {
                shipment.tags.push({ name: String(orderData.customField1) });
            }
            if (orderData.customField2) {
                shipment.tags.push({ name: String(orderData.customField2) });
            }
        }

        // Note: Packages are not required when create_sales_order is true
        // ShipStation will handle package creation during label generation

        return shipment;
    }

    /**
     * Get all warehouses (shipping warehouses with origin_address)
     * @returns {Promise<Array>} Array of warehouse objects with origin_address (ship_from)
     */
    async getWarehouses() {
        try {
            const response = await this.client.get('/v2/warehouses');
            return response.data?.warehouses || [];
        } catch (error) {
            console.error('Error fetching warehouses:', error.message);
            throw error;
        }
    }

    /**
     * Get inventory warehouses (different from shipping warehouses)
     * @returns {Promise<Array>} Array of inventory warehouse objects
     */
    async getInventoryWarehouses() {
        try {
            const response = await this.client.get('/v2/inventory_warehouses');
            return response.data?.inventory_warehouses || [];
        } catch (error) {
            console.error('Error fetching inventory warehouses:', error.message);
            throw error;
        }
    }

    /**
     * Get default warehouse ID
     * @returns {Promise<string|null>} Warehouse ID or null if not found
     */
    async getDefaultWarehouseId() {
        try {
            const warehouses = await this.getWarehouses();
            if (warehouses.length > 0) {
                return warehouses[0].warehouse_id;
            }
            return null;
        } catch (error) {
            console.warn('Could not fetch warehouses:', error.message);
            return null;
        }
    }

    /**
     * Create an order in ShipStation
     * 
     * IMPORTANT: ShipStation API v2 does NOT have a /v2/orders/createorder endpoint.
     * Instead, orders are created by creating shipments via /v2/shipments with create_sales_order: true.
     * 
     * @param {Object} orderData - Order data in ShipStation format
     * @returns {Promise<Object>} Created order/shipment details
     */
    async createOrder(orderData) {
        try {
            console.log('Creating order in ShipStation via v2 shipments API:', orderData.orderNumber);
            console.log('   (Note: v2 API uses /v2/shipments endpoint, not /v2/orders/createorder)');
            
            // ShipStation API v2 creates orders through shipments with create_sales_order: true
            // The /v2/orders/createorder endpoint does NOT exist in v2 API
            const shipment = this.convertOrderToShipment(orderData);
            
            // Per OpenAPI spec: Either ship_from OR warehouse_id must be set
            // If neither is set, try to get default warehouse as fallback
            if (!shipment.ship_from && !shipment.warehouse_id) {
                const defaultWarehouseId = await this.getDefaultWarehouseId();
                if (defaultWarehouseId) {
                    shipment.warehouse_id = defaultWarehouseId;
                    console.log('Using default warehouse:', defaultWarehouseId);
                } else {
                    throw new Error(
                        'Per ShipStation API v2 spec: Either ship_from OR warehouse_id must be provided. ' +
                        'Please either:\n' +
                        '  1. Configure ship_from address using SHIPSTATION_SHIP_FROM_* environment variables (recommended), or\n' +
                        '  2. Create a warehouse in ShipStation and configure SHIPSTATION_WAREHOUSE_ID in your .env file'
                    );
                }
            }
            
            const requestBody = {
                shipments: [shipment]
            };
            
            // POST to /v2/shipments (NOT /v2/orders/createorder which doesn't exist in v2)
            const response = await this.client.post('/v2/shipments', requestBody);
            
            if (response.data && response.data.shipments && response.data.shipments.length > 0) {
                const createdShipment = response.data.shipments[0];
                
                if (createdShipment.errors && createdShipment.errors.length > 0) {
                    throw new Error(`ShipStation API errors: ${createdShipment.errors.join(', ')}`);
                }
                
                console.log('Order created in ShipStation via shipment:', createdShipment.shipment_id);
                
                // Return shipment details including ship_from if available in response
                const result = {
                    order_id: createdShipment.sales_order_id || createdShipment.shipment_id,
                    order_number: createdShipment.shipment_number || orderData.orderNumber,
                    shipment_id: createdShipment.shipment_id,
                    sales_order_id: createdShipment.sales_order_id
                };
                
                // Include ship_from from response if available (ShipStation may return it)
                if (createdShipment.ship_from) {
                    result.ship_from = createdShipment.ship_from;
                } else if (createdShipment.warehouse_id) {
                    result.warehouse_id = createdShipment.warehouse_id;
                }
                
                // Also include the ship_from we sent (for reference, even if not in response)
                if (shipment.ship_from) {
                    result.sent_ship_from = shipment.ship_from;
                }
                if (shipment.warehouse_id) {
                    result.sent_warehouse_id = shipment.warehouse_id;
                }
                
                return result;
            }
            
            throw new Error('Unexpected response format from ShipStation API');
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
            const response = await this.client.get(`/v2/orders/${orderId}`);
            return response.data;
        } catch (error) {
            console.error('Error getting order from ShipStation:', error.message);
            throw error;
        }
    }

    /**
     * Cancel a shipment (which cancels the associated order)
     * In ShipStation v2, orders created via shipments can be cancelled by cancelling the shipment
     * @param {string} shipmentId - ShipStation shipment ID
     * @returns {Promise<Object>} Cancellation result
     */
    async cancelShipment(shipmentId) {
        try {
            console.log(`Cancelling shipment ${shipmentId} in ShipStation...`);
            const response = await this.client.put(`/v2/shipments/${shipmentId}/cancel`);
            
            // 204 No Content means success
            if (response.status === 204 || response.status === 200) {
                console.log(`✅ Shipment ${shipmentId} cancelled successfully`);
                return {
                    success: true,
                    shipment_id: shipmentId,
                    message: 'Shipment cancelled successfully'
                };
            }
            
            return {
                success: true,
                shipment_id: shipmentId,
                data: response.data
            };
        } catch (error) {
            console.error('Error cancelling shipment:', error.message);
            throw error;
        }
    }

    /**
     * Delete/Cancel an order by shipment ID
     * Since orders are created via shipments, we cancel the shipment to cancel the order
     * @param {string} shipmentId - ShipStation shipment ID
     * @returns {Promise<Object>} Cancellation result
     */
    async deleteOrderByShipmentId(shipmentId) {
        return await this.cancelShipment(shipmentId);
    }

    /**
     * Delete/Cancel an order by order ID
     * First finds the shipment associated with the order, then cancels it
     * @param {string} orderId - ShipStation order ID (sales_order_id)
     * @returns {Promise<Object>} Cancellation result
     */
    async deleteOrderByOrderId(orderId) {
        try {
            console.log(`Finding shipment for order ${orderId}...`);
            
            // Try to get the order first to find associated shipment
            try {
                const order = await this.getOrderById(orderId);
                
                // Search for shipment by sales_order_id or order number
                if (order.shipment_id) {
                    console.log(`Found shipment ID: ${order.shipment_id}`);
                    return await this.cancelShipment(order.shipment_id);
                }
                
                // If no shipment_id in order, search by order number
                if (order.order_number) {
                    return await this.deleteOrderByOrderNumber(order.order_number);
                }
            } catch (orderError) {
                console.warn(`Could not get order ${orderId}, trying to find shipment by sales_order_id...`);
            }
            
            // Try to find shipment by sales_order_id query parameter
            const shipmentsResponse = await this.client.get('/v2/shipments', {
                params: {
                    sales_order_id: orderId,
                    page_size: 1
                }
            });
            
            const shipments = shipmentsResponse.data?.shipments || [];
            if (shipments.length > 0) {
                const shipmentId = shipments[0].shipment_id;
                console.log(`Found shipment ${shipmentId} for order ${orderId}`);
                return await this.cancelShipment(shipmentId);
            }
            
            throw new Error(`No shipment found for order ID ${orderId}`);
        } catch (error) {
            console.error(`Error deleting order ${orderId}:`, error.message);
            throw error;
        }
    }

    /**
     * Delete/Cancel an order by order number (external reference)
     * Finds the shipment by shipment_number or external_shipment_id, then cancels it
     * @param {string} orderNumber - Order number (PO number or shipment number)
     * @returns {Promise<Object>} Cancellation result
     */
    async deleteOrderByOrderNumber(orderNumber) {
        try {
            console.log(`Finding shipment for order number ${orderNumber}...`);
            
            // Try to find shipment by external_shipment_id first (which is usually the order number)
            try {
                const shipmentResponse = await this.client.get(
                    `/v2/shipments/external_shipment_id/${orderNumber}`
                );
                const shipment = shipmentResponse.data;
                if (shipment.shipment_id) {
                    console.log(`Found shipment ${shipment.shipment_id} by external_shipment_id`);
                    return await this.cancelShipment(shipment.shipment_id);
                }
            } catch (externalError) {
                // If not found by external ID, try by shipment_number
                console.log(`Not found by external_shipment_id, trying shipment_number...`);
            }
            
            // Try to find by shipment_number
            const shipmentsResponse = await this.client.get('/v2/shipments', {
                params: {
                    shipment_number: orderNumber,
                    page_size: 1
                }
            });
            
            const shipments = shipmentsResponse.data?.shipments || [];
            if (shipments.length > 0) {
                const shipmentId = shipments[0].shipment_id;
                console.log(`Found shipment ${shipmentId} by shipment_number`);
                return await this.cancelShipment(shipmentId);
            }
            
            throw new Error(`No shipment found for order number ${orderNumber}`);
        } catch (error) {
            console.error(`Error deleting order ${orderNumber}:`, error.message);
            throw error;
        }
    }

    /**
     * Get shipment details with tracking information
     * @param {string} shipmentId - ShipStation shipment ID
     * @returns {Promise<Object>} Shipment data with tracking info
     */
    async getShipmentById(shipmentId) {
        try {
            const response = await this.client.get(`/v2/shipments/${shipmentId}`);
            return response.data;
        } catch (error) {
            console.error('Error getting shipment from ShipStation:', error.message);
            throw error;
        }
    }

    /**
     * Get shipment by external shipment ID (order number)
     * @param {string} externalShipmentId - External shipment ID (usually order number)
     * @returns {Promise<Object>} Shipment data with tracking info
     */
    async getShipmentByExternalId(externalShipmentId) {
        try {
            const response = await this.client.get(`/v2/shipments/external_shipment_id/${externalShipmentId}`);
            return response.data;
        } catch (error) {
            console.error('Error getting shipment by external ID:', error.message);
            throw error;
        }
    }

    /**
     * Get shipment tracking information
     * @param {string} shipmentId - ShipStation shipment ID
     * @returns {Promise<Object>} Tracking information
     */
    async getShipmentTracking(shipmentId) {
        try {
            const shipment = await this.getShipmentById(shipmentId);
            
            // Extract tracking information from shipment
            // Tracking can be at shipment level or package level
            let trackingNumber = shipment.tracking_number || 
                                shipment.tracking || 
                                null;

            // Check packages for tracking numbers
            if (!trackingNumber && shipment.packages && shipment.packages.length > 0) {
                // Get first package tracking number
                const firstPackage = shipment.packages[0];
                trackingNumber = firstPackage.tracking_number || 
                                firstPackage.tracking || 
                                firstPackage.tracking_code ||
                                null;
            }

            const trackingInfo = {
                shipment_id: shipment.shipment_id,
                shipment_number: shipment.shipment_number,
                shipment_status: shipment.shipment_status,
                tracking_number: trackingNumber,
                carrier_id: shipment.carrier_id || null,
                carrier_name: shipment.carrier_name || null,
                ship_date: shipment.ship_date || null,
                estimated_delivery_date: shipment.estimated_delivery_date || null,
                packages: shipment.packages || []
            };

            // Get tracking numbers from packages if available
            if (shipment.packages && shipment.packages.length > 0) {
                trackingInfo.packages = shipment.packages.map(pkg => {
                    const packageInfo = {
                        package_id: pkg.package_id || pkg.packageId || null,
                        tracking_number: pkg.tracking_number || pkg.tracking || pkg.tracking_code || null,
                        carrier: pkg.carrier_id || pkg.carrier_name || pkg.carrier || null,
                        dimensions: pkg.dimensions || null
                    };
                    
                    // Format weight properly
                    if (pkg.weight) {
                        if (typeof pkg.weight === 'object') {
                            packageInfo.weight = {
                                value: pkg.weight.value || pkg.weight.amount || 'N/A',
                                unit: pkg.weight.unit || 'lb',
                                display: `${pkg.weight.value || pkg.weight.amount || 'N/A'} ${pkg.weight.unit || 'lb'}`
                            };
                        } else {
                            packageInfo.weight = {
                                value: pkg.weight,
                                unit: 'lb',
                                display: `${pkg.weight} lb`
                            };
                        }
                    }
                    
                    return packageInfo;
                });

                // Update main tracking_number if found in packages but not at shipment level
                if (!trackingInfo.tracking_number && trackingInfo.packages.length > 0) {
                    const firstPackageWithTracking = trackingInfo.packages.find(p => p.tracking_number);
                    if (firstPackageWithTracking) {
                        trackingInfo.tracking_number = firstPackageWithTracking.tracking_number;
                    }
                }
            }

            return trackingInfo;
        } catch (error) {
            console.error('Error getting shipment tracking:', error.message);
            throw error;
        }
    }

    /**
     * Get tracking information by order number
     * @param {string} orderNumber - Order number (PO number or shipment number)
     * @returns {Promise<Object>} Tracking information
     */
    async getTrackingByOrderNumber(orderNumber) {
        try {
            // Try to get shipment by external_shipment_id first
            try {
                const shipment = await this.getShipmentByExternalId(orderNumber);
                return await this.getShipmentTracking(shipment.shipment_id);
            } catch (error) {
                // If not found, try by shipment_number
                const shipmentsResponse = await this.client.get('/v2/shipments', {
                    params: {
                        shipment_number: orderNumber,
                        page_size: 1
                    }
                });

                const shipments = shipmentsResponse.data?.shipments || [];
                if (shipments.length > 0) {
                    return await this.getShipmentTracking(shipments[0].shipment_id);
                }

                throw new Error(`No shipment found for order number ${orderNumber}`);
            }
        } catch (error) {
            console.error('Error getting tracking by order number:', error.message);
            throw error;
        }
    }

    /**
     * Get tracking information by tracking number
     * @param {string} trackingNumber - Tracking number
     * @returns {Promise<Object>} Tracking information
     */
    async getTrackingByTrackingNumber(trackingNumber) {
        try {
            // Search fulfillments by tracking number
            const fulfillmentsResponse = await this.client.get('/v2/fulfillments', {
                params: {
                    tracking_number: trackingNumber,
                    page_size: 1
                }
            });

            const fulfillments = fulfillmentsResponse.data?.fulfillments || [];
            if (fulfillments.length > 0) {
                const fulfillment = fulfillments[0];
                return {
                    fulfillment_id: fulfillment.fulfillment_id,
                    shipment_id: fulfillment.shipment_id,
                    shipment_number: fulfillment.shipment_number,
                    tracking_number: fulfillment.tracking_number,
                    carrier_id: fulfillment.carrier_id,
                    carrier_name: fulfillment.carrier_name,
                    ship_date: fulfillment.ship_date,
                    estimated_delivery_date: fulfillment.estimated_delivery_date,
                    packages: fulfillment.packages || []
                };
            }

            // Fallback: Search shipments by tracking number
            const shipmentsResponse = await this.client.get('/v2/shipments', {
                params: {
                    page_size: 100 // Search in recent shipments
                }
            });

            const shipments = shipmentsResponse.data?.shipments || [];
            const matchingShipment = shipments.find(s => 
                s.tracking_number === trackingNumber ||
                (s.packages && s.packages.some(pkg => pkg.tracking_number === trackingNumber))
            );

            if (matchingShipment) {
                return await this.getShipmentTracking(matchingShipment.shipment_id);
            }

            throw new Error(`No shipment found for tracking number ${trackingNumber}`);
        } catch (error) {
            console.error('Error getting tracking by tracking number:', error.message);
            throw error;
        }
    }

    /**
     * Get fulfillments (shipped orders with tracking)
     * @param {Object} params - Query parameters (shipment_id, shipment_number, tracking_number, etc.)
     * @returns {Promise<Object>} Fulfillments list
     */
    async getFulfillments(params = {}) {
        try {
            const response = await this.client.get('/v2/fulfillments', { params });
            return response.data;
        } catch (error) {
            console.error('Error getting fulfillments:', error.message);
            throw error;
        }
    }

    /**
     * Get shipments with tracking information
     * @param {Object} params - Query parameters (shipment_status, shipment_number, etc.)
     * @param {boolean} usePositionTracking - Whether to use position tracking to get only new shipments since last call
     * @returns {Promise<Object>} Shipments list with tracking info
     */
    async getShipmentsWithTracking(params = {}, usePositionTracking = false) {
        try {
            // Position tracking removed - use webhooks instead (per Project.md)
            if (usePositionTracking) {
                console.warn('[Position Tracking] Position tracking is disabled. Use webhooks for Step 2 instead.');
            }

            const response = await this.client.get('/v2/shipments', { params });
            const shipments = response.data?.shipments || [];
            
            // Enrich shipments with tracking information
            const shipmentsWithTracking = shipments.map(shipment => ({
                shipment_id: shipment.shipment_id,
                shipment_number: shipment.shipment_number,
                shipment_status: shipment.shipment_status,
                tracking_number: shipment.tracking_number,
                carrier_id: shipment.carrier_id,
                carrier_name: shipment.carrier_name,
                ship_date: shipment.ship_date,
                estimated_delivery_date: shipment.estimated_delivery_date,
                packages: shipment.packages || [],
                ship_to: shipment.ship_to,
                sales_order_id: shipment.sales_order_id,
                modified_at: shipment.modified_at,
                created_at: shipment.created_at
            }));

            // Position tracking removed - use webhooks instead (per Project.md)

            return {
                shipments: shipmentsWithTracking,
                total: response.data?.total || shipmentsWithTracking.length,
                page: response.data?.page || 1,
                pages: response.data?.pages || 1,
                positionTracking: usePositionTracking ? {
                    enabled: true,
                    lastPosition: await this.positionTracker.getLastPosition('shipments')
                } : null
            };
        } catch (error) {
            console.error('Error getting shipments with tracking:', error.message);
            throw error;
        }
    }

    /**
     * Get shipped orders with complete order and tracking information
     * Returns orders that have labels purchased (label_purchased status)
     * Note: 'shipped' is not a valid shipment_status - use getFulfillments() for fully shipped orders
     * @param {Object} params - Query parameters (ship_date_start, ship_date_end, page, page_size, etc.)
     * @param {boolean} usePositionTracking - Whether to use position tracking to get only new orders since last call
     * @returns {Promise<Object>} Shipped orders with tracking info
     */
    async getShippedOrders(params = {}, usePositionTracking = false) {
        try {
            // Default to shipped or label_purchased status if not specified
            const queryParams = {
                shipment_status: params.shipment_status || 'label_purchased',
                page_size: params.page_size || 50,
                page: params.page || 1,
                sort_by: params.sort_by || 'modified_at', // Use modified_at instead of ship_date
                sort_dir: params.sort_dir || 'desc',
                ...params
            };

            // Remove shipment_status from params if it was explicitly set
            if (params.shipment_status) {
                queryParams.shipment_status = params.shipment_status;
            }

            // Position tracking removed - use webhooks instead (per Project.md)
            if (usePositionTracking) {
                console.warn('[Position Tracking] Position tracking is disabled. Use webhooks for Step 2 instead.');
            }

            const response = await this.client.get('/v2/shipments', { params: queryParams });
            const shipments = response.data?.shipments || [];

            // Enrich shipments with order information
            const shippedOrders = await Promise.all(
                shipments.map(async (shipment) => {
                    let order = null;
                    
                    // Try to get order information if sales_order_id exists
                    if (shipment.sales_order_id) {
                        try {
                            order = await this.getOrderById(shipment.sales_order_id);
                        } catch (error) {
                            console.warn(`Could not get order ${shipment.sales_order_id}:`, error.message);
                        }
                    }

                    // Extract tracking information
                    let trackingNumber = shipment.tracking_number || null;
                    if (!trackingNumber && shipment.packages && shipment.packages.length > 0) {
                        const firstPackage = shipment.packages[0];
                        trackingNumber = firstPackage.tracking_number || 
                                       firstPackage.tracking || 
                                       firstPackage.tracking_code || 
                                       null;
                    }

                    return {
                        // Order information
                        order_id: order?.order_id || shipment.sales_order_id || null,
                        order_number: order?.order_number || shipment.shipment_number || null,
                        order_status: order?.order_status || null,
                        order_date: order?.order_date || null,
                        
                        // Shipment information
                        shipment_id: shipment.shipment_id,
                        shipment_number: shipment.shipment_number,
                        shipment_status: shipment.shipment_status,
                        
                        // Tracking information
                        tracking_number: trackingNumber,
                        carrier_id: shipment.carrier_id,
                        carrier_name: shipment.carrier_name,
                        ship_date: shipment.ship_date,
                        estimated_delivery_date: shipment.estimated_delivery_date,
                        
                        // Package information
                        packages: (shipment.packages || []).map(pkg => ({
                            package_id: pkg.package_id || pkg.packageId,
                            tracking_number: pkg.tracking_number || pkg.tracking || pkg.tracking_code,
                            carrier: pkg.carrier_id || pkg.carrier_name,
                            weight: pkg.weight,
                            dimensions: pkg.dimensions
                        })),
                        
                        // Address information
                        ship_to: shipment.ship_to,
                        ship_from: shipment.ship_from,
                        
                        // Customer information
                        customer: order?.customer || null,
                        
                        // Rithum order ID (from tags/customField2)
                        rithum_order_id: this.extractRithumOrderId(shipment, order),
                        
                        // Additional metadata
                        created_at: shipment.created_at || shipment.modified_at,
                        modified_at: shipment.modified_at
                    };
                })
            );

            // Position tracking removed - use webhooks instead (per Project.md)

            return {
                orders: shippedOrders,
                total: response.data?.total || shippedOrders.length,
                page: response.data?.page || queryParams.page,
                pages: response.data?.pages || 1,
                page_size: queryParams.page_size,
                positionTracking: null // Position tracking removed - use webhooks instead
            };
        } catch (error) {
            console.error('Error getting shipped orders:', error.message);
            throw error;
        }
    }

    /**
     * Get shipments with position tracking (stream-like functionality)
     * Only returns shipments modified since the last call
     * @param {Object} params - Query parameters
     * @returns {Promise<Object>} New shipments since last call
     */
    async getNewShipments(params = {}) {
        return await this.getShippedOrders(params, true);
    }

    /**
     * Get position tracking status for shipped orders
     * @returns {Promise<Object|null>} Position tracking metadata (deprecated - use webhooks instead)
     */
    async getShippedOrdersPosition() {
        console.warn('[Position Tracking] Position tracking is disabled. Use webhooks for Step 2 instead.');
        return null;
    }

    /**
     * Reset position tracking for shipped orders
     * @deprecated Use webhooks instead (per Project.md)
     */
    async resetShippedOrdersPosition() {
        console.warn('[Position Tracking] Position tracking is disabled. Use webhooks for Step 2 instead.');
    }

    /**
     * List all webhooks
     * @returns {Promise<Array>} List of webhooks
     */
    async listWebhooks() {
        try {
            const response = await this.client.get('/v2/environment/webhooks');
            return response.data?.webhooks || [];
        } catch (error) {
            console.error('Error listing webhooks:', error.message);
            throw error;
        }
    }

    /**
     * Create a webhook
     * @param {string} name - Webhook name
     * @param {string} event - Event type (e.g., 'fulfillment_shipped_v2', 'label_created_v2', 'shipment_created_v2')
     * @param {string} url - Webhook URL to receive notifications
     * @returns {Promise<Object>} Created webhook
     */
    async createWebhook(name, event, url) {
        try {
            const webhookData = {
                name: name,
                event: event,
                url: url
            };
            
            const response = await this.client.post('/v2/environment/webhooks', webhookData);
            console.log(`Webhook created: ${response.data?.webhook_id}`);
            return response.data;
        } catch (error) {
            console.error('Error creating webhook:', error.message);
            throw error;
        }
    }

    /**
     * Get webhook by ID
     * @param {string} webhookId - Webhook ID
     * @returns {Promise<Object>} Webhook details
     */
    async getWebhook(webhookId) {
        try {
            const response = await this.client.get(`/v2/environment/webhooks/${webhookId}`);
            return response.data;
        } catch (error) {
            console.error('Error getting webhook:', error.message);
            throw error;
        }
    }

    /**
     * Update webhook URL
     * @param {string} webhookId - Webhook ID
     * @param {string} url - New webhook URL
     * @returns {Promise<Object>} Updated webhook
     */
    async updateWebhook(webhookId, url) {
        try {
            const response = await this.client.put(`/v2/environment/webhooks/${webhookId}`, { url });
            console.log(`Webhook ${webhookId} updated`);
            return response.data;
        } catch (error) {
            console.error('Error updating webhook:', error.message);
            throw error;
        }
    }

    /**
     * Delete webhook
     * @param {string} webhookId - Webhook ID
     */
    async deleteWebhook(webhookId) {
        try {
            await this.client.delete(`/v2/environment/webhooks/${webhookId}`);
            console.log(`Webhook ${webhookId} deleted`);
        } catch (error) {
            console.error('Error deleting webhook:', error.message);
            throw error;
        }
    }

    /**
     * Extract Rithum order ID from shipment or order
     * @param {Object} shipment - Shipment object
     * @param {Object} order - Order object (optional)
     * @returns {string|null} Rithum order ID
     */
    extractRithumOrderId(shipment, order = null) {
        // Method 1: Check shipment tags (customField2 becomes a tag)
        if (shipment.tags && Array.isArray(shipment.tags)) {
            const dscoTag = shipment.tags.find(tag => {
                const tagName = tag.name || '';
                return tagName.match(/^\d+$/) || tagName.toLowerCase().includes('dsco');
            });
            if (dscoTag) {
                return dscoTag.name;
            }
        }

        // Method 2: Check order customField2
        if (order) {
            if (order.customField2) {
                return order.customField2;
            }
            if (order.tags && Array.isArray(order.tags)) {
                const dscoTag = order.tags.find(tag => {
                    const tagName = tag.name || '';
                    return tagName.match(/^\d+$/) || tagName.toLowerCase().includes('dsco');
                });
                if (dscoTag) {
                    return dscoTag.name;
                }
            }
        }

        // Method 3: Use shipment_number if it looks like a Rithum order ID
        if (shipment.shipment_number && shipment.shipment_number.match(/^\d+$/)) {
            return shipment.shipment_number;
        }

        return null;
    }

    /**
     * Test connection to ShipStation
     * @returns {Promise<Object>} Test result
     */
    async testConnection() {
        try {
            // Use a simple endpoint to test connection - try /v2/inventory_warehouses as it's lightweight
            const response = await this.client.get('/v2/inventory_warehouses', { params: { page_size: 1 } });
            return {
                success: true,
                message: 'ShipStation connection successful',
                data: response.data
            };
        } catch (error) {
            return {
                success: false,
                message: 'ShipStation connection failed',
                error: error.message,
                status: error.response?.status,
                statusText: error.response?.statusText,
                responseData: error.response?.data
            };
        }
    }
}

module.exports = ShipStationClient;

