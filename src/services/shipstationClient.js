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

        // Add warehouse_id if provided in config, advanced options, or order data
        if (this.warehouseId) {
            shipment.warehouse_id = this.warehouseId;
        } else if (orderData.warehouse_id) {
            shipment.warehouse_id = orderData.warehouse_id;
        } else if (orderData.advancedOptions && orderData.advancedOptions.warehouseId) {
            shipment.warehouse_id = orderData.advancedOptions.warehouseId;
        }

        // Add ship_from address if provided (alternative to warehouse_id)
        if (!shipment.warehouse_id) {
            if (this.shipFrom) {
                shipment.ship_from = this.shipFrom;
            } else if (orderData.shipFrom) {
                shipment.ship_from = orderData.shipFrom;
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
     * Get all warehouses
     * @returns {Promise<Array>} Array of warehouse objects
     */
    async getWarehouses() {
        try {
            const response = await this.client.get('/v2/inventory_warehouses');
            return response.data?.inventory_warehouses || [];
        } catch (error) {
            console.error('Error fetching warehouses:', error.message);
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
            
            // If no warehouse_id or ship_from is set, try to get default warehouse
            if (!shipment.warehouse_id && !shipment.ship_from) {
                const defaultWarehouseId = await this.getDefaultWarehouseId();
                if (defaultWarehouseId) {
                    shipment.warehouse_id = defaultWarehouseId;
                    console.log('Using default warehouse:', defaultWarehouseId);
                } else {
                    throw new Error(
                        'No warehouse_id or ship_from address provided, and no default warehouse found. ' +
                        'Please either:\n' +
                        '  1. Create a warehouse in ShipStation and configure SHIPSTATION_WAREHOUSE_ID in your .env file, or\n' +
                        '  2. Configure ship_from address using SHIPSTATION_SHIP_FROM_* environment variables'
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

