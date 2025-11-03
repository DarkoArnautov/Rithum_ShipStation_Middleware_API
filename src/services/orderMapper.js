/**
 * Order Mapper Service
 * Transforms Rithum orders to ShipStation order format
 * 
 * Note: Uses ShipStation v1 API format
 * - Address fields: street1, city, state, postalCode, country
 * - Endpoint: /orders/createorder
 * 
 * If migrating to v2 API, update field mappings:
 * - address_line1, city_locality, state_province, postal_code, country_code
 * - address_residential_indicator (required in v2)
 */
class OrderMapper {
    /**
     * Map Rithum order to ShipStation order format
     * @param {Object} rithumOrder - Order from Rithum API
     * @returns {Object} ShipStation order format
     */
    mapToShipStation(rithumOrder) {
        if (!rithumOrder) {
            throw new Error('Rithum order is required');
        }

        const shipstationOrder = {
            orderNumber: rithumOrder.poNumber,
            orderDate: this.mapOrderDate(rithumOrder),
            orderStatus: this.mapOrderStatus(rithumOrder.dscoStatus),
            amountPaid: rithumOrder.extendedExpectedCostTotal || 0,
            currencyCode: "USD",
            customerUsername: this.getCustomerName(rithumOrder.shipping),
            shipTo: this.mapShippingAddress(rithumOrder.shipping),
            items: this.mapLineItems(rithumOrder.lineItems || [])
        };

        // Optional fields - only include if they have values
        if (rithumOrder.shipByDate) {
            shipstationOrder.shipByDate = rithumOrder.shipByDate;
        }

        if (rithumOrder.dscoOrderId) {
            shipstationOrder.orderKey = rithumOrder.dscoOrderId;
        }

        // Custom fields for tracking
        if (rithumOrder.channel) {
            shipstationOrder.customField1 = rithumOrder.channel;
        }

        // Required: Store Rithum order ID in customField2 for tracking
        if (rithumOrder.dscoOrderId) {
            shipstationOrder.customField2 = rithumOrder.dscoOrderId;
        }

        // Advanced options
        if (rithumOrder.channel) {
            shipstationOrder.advancedOptions = {
                customField1: rithumOrder.channel
            };
        }

        return shipstationOrder;
    }

    /**
     * Map order date with fallbacks
     * @param {Object} rithumOrder - Order from Rithum
     * @returns {string} ISO date string
     */
    mapOrderDate(rithumOrder) {
        const date = rithumOrder.consumerOrderDate || 
                     rithumOrder.retailerCreateDate || 
                     rithumOrder.dscoCreateDate ||
                     new Date().toISOString();
        
        // Ensure valid ISO format
        try {
            new Date(date).toISOString();
            return date;
        } catch (error) {
            console.warn('Invalid date format, using current date:', date);
            return new Date().toISOString();
        }
    }

    /**
     * Map Rithum order status to ShipStation status
     * @param {string} rithumStatus - Status from Rithum
     * @returns {string} ShipStation status
     */
    mapOrderStatus(rithumStatus) {
        const statusMap = {
            'created': 'awaiting_shipment',
            'shipment_pending': 'awaiting_shipment',
            'shipped': 'shipped',
            'cancelled': 'cancelled'
        };
        return statusMap[rithumStatus] || 'awaiting_shipment';
    }

    /**
     * Get customer name from shipping address
     * @param {Object} shipping - Shipping address object
     * @returns {string} Customer name
     */
    getCustomerName(shipping) {
        if (!shipping) {
            return 'Customer';
        }
        
        if (shipping.name) {
            return shipping.name;
        }
        
        if (shipping.firstName && shipping.lastName) {
            return `${shipping.firstName} ${shipping.lastName}`;
        }
        
        if (shipping.firstName) {
            return shipping.firstName;
        }
        
        return 'Customer';
    }

    /**
     * Map shipping address from Rithum to ShipStation format
     * Note: Using ShipStation v1 API format (street1, city, state, postalCode)
     * If using v2 API, fields would be: address_line1, city_locality, state_province, postal_code
     * @param {Object} shipping - Shipping address from Rithum
     * @returns {Object} ShipStation shipping address (v1 format)
     */
    mapShippingAddress(shipping) {
        if (!shipping) {
            throw new Error('Shipping address is required');
        }

        const address = {
            name: this.getCustomerName(shipping),
            street1: shipping.address1 || '',
            street2: this.getStreet2(shipping),
            city: shipping.city || '',
            state: shipping.state || shipping.region || '',
            postalCode: shipping.postal || '',
            country: shipping.country || 'US'
        };

        // Phone is required for ShipStation (based on OpenAPI spec)
        // If missing, use a placeholder or make it optional based on API version
        if (shipping.phone) {
            address.phone = shipping.phone;
        }

        // Remove null/empty street2 to avoid issues
        if (!address.street2) {
            delete address.street2;
        }

        return address;
    }

    /**
     * Get second address line if available
     * @param {Object} shipping - Shipping address
     * @returns {string|null} Second address line
     */
    getStreet2(shipping) {
        if (shipping.address && Array.isArray(shipping.address) && shipping.address.length > 1) {
            return shipping.address[1];
        }
        return null;
    }

    /**
     * Map line items from Rithum to ShipStation format
     * @param {Array} lineItems - Line items from Rithum
     * @returns {Array} ShipStation items array
     */
    mapLineItems(lineItems) {
        if (!Array.isArray(lineItems)) {
            return [];
        }

        return lineItems
            .filter(item => {
                // Filter out items with zero or negative quantity
                const quantity = item.acceptedQuantity || item.quantity || 0;
                return quantity > 0;
            })
            .map((item, index) => {
                const mappedItem = {
                    sku: this.getItemSku(item, index),
                    name: item.title || 'Unknown Item',
                    quantity: item.acceptedQuantity || item.quantity || 1,
                    unitPrice: this.getItemPrice(item)
                };

                // Add personalization as option if present
                if (item.personalization) {
                    mappedItem.options = [{
                        name: 'Personalization',
                        value: String(item.personalization)
                    }];
                }

                return mappedItem;
            });
    }

    /**
     * Get SKU for line item with fallbacks
     * @param {Object} item - Line item from Rithum
     * @param {number} index - Item index for fallback
     * @returns {string} SKU
     */
    getItemSku(item, index) {
        if (item.sku) {
            return item.sku;
        }
        if (item.partnerSku) {
            return item.partnerSku;
        }
        if (item.productGroup) {
            return item.productGroup;
        }
        console.warn(`No SKU found for item at index ${index}, using generated SKU`);
        return `ITEM-${index + 1}`;
    }

    /**
     * Get price for line item with fallbacks
     * @param {Object} item - Line item from Rithum
     * @returns {number} Unit price
     */
    getItemPrice(item) {
        if (item.expectedCost !== undefined && item.expectedCost !== null) {
            return parseFloat(item.expectedCost) || 0;
        }
        if (item.consumerPrice !== undefined && item.consumerPrice !== null) {
            return parseFloat(item.consumerPrice) || 0;
        }
        if (item.extendedExpectedCostTotal !== undefined && item.extendedExpectedCostTotal !== null) {
            const quantity = item.acceptedQuantity || item.quantity || 1;
            return parseFloat(item.extendedExpectedCostTotal) / quantity || 0;
        }
        return 0;
    }

    /**
     * Validate that order can be mapped
     * @param {Object} rithumOrder - Order from Rithum
     * @returns {Object} Validation result with isValid flag and errors array
     */
    validate(rithumOrder) {
        const errors = [];

        if (!rithumOrder) {
            return {
                isValid: false,
                errors: ['Order object is required']
            };
        }

        // Validate required order fields
        if (!rithumOrder.poNumber) {
            errors.push('Missing poNumber (required for orderNumber)');
        }

        // Validate shipping address
        if (!rithumOrder.shipping) {
            errors.push('Missing shipping address');
        } else {
            if (!rithumOrder.shipping.address1) {
                errors.push('Missing shipping.address1');
            }
            if (!rithumOrder.shipping.city) {
                errors.push('Missing shipping.city');
            }
            if (!rithumOrder.shipping.state && !rithumOrder.shipping.region) {
                errors.push('Missing shipping.state or shipping.region');
            }
            if (!rithumOrder.shipping.postal) {
                errors.push('Missing shipping.postal');
            }
            // Note: phone is recommended but not always required depending on API version
            // Country is optional, default to US
        }

        // Validate line items
        if (!rithumOrder.lineItems || !Array.isArray(rithumOrder.lineItems) || rithumOrder.lineItems.length === 0) {
            errors.push('Missing or empty lineItems array');
        } else {
            // Validate each line item has required fields
            rithumOrder.lineItems.forEach((item, index) => {
                const quantity = item.acceptedQuantity || item.quantity || 0;
                if (quantity <= 0) {
                    errors.push(`Line item ${index + 1}: Invalid quantity (${quantity})`);
                }
                if (!item.sku && !item.partnerSku && !item.productGroup) {
                    errors.push(`Line item ${index + 1}: Missing SKU (sku, partnerSku, or productGroup)`);
                }
            });
        }

        // Validate dscoOrderId (required for tracking)
        if (!rithumOrder.dscoOrderId) {
            errors.push('Missing dscoOrderId (required for customField2 tracking)');
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Check if order should be processed based on business rules
     * @param {Object} rithumOrder - Order from Rithum
     * @returns {boolean} Should process this order
     */
    shouldProcess(rithumOrder) {
        if (!rithumOrder) {
            return false;
        }

        // Skip test orders if configured
        if (process.env.SKIP_TEST_ORDERS === 'true' && rithumOrder.testFlag) {
            console.log(`Skipping test order: ${rithumOrder.dscoOrderId}`);
            return false;
        }

        // Skip cancelled orders
        if (rithumOrder.dscoStatus === 'cancelled') {
            console.log(`Skipping cancelled order: ${rithumOrder.dscoOrderId}`);
            return false;
        }

        // Skip already shipped orders (for new order sync)
        if (rithumOrder.dscoStatus === 'shipped') {
            console.log(`Skipping already shipped order: ${rithumOrder.dscoOrderId}`);
            return false;
        }

        // Only process orders in certain statuses
        const processableStatuses = ['created', 'shipment_pending'];
        if (!processableStatuses.includes(rithumOrder.dscoStatus)) {
            console.log(`Skipping order with status ${rithumOrder.dscoStatus}: ${rithumOrder.dscoOrderId}`);
            return false;
        }

        return true;
    }

    /**
     * Map and validate order in one step
     * @param {Object} rithumOrder - Order from Rithum
     * @returns {Object} Result with mapped order and validation info
     */
    mapAndValidate(rithumOrder) {
        const validation = this.validate(rithumOrder);
        
        if (!validation.isValid) {
            return {
                success: false,
                validation,
                mappedOrder: null,
                errors: validation.errors
            };
        }

        try {
            const mappedOrder = this.mapToShipStation(rithumOrder);
            return {
                success: true,
                validation,
                mappedOrder,
                errors: []
            };
        } catch (error) {
            return {
                success: false,
                validation,
                mappedOrder: null,
                errors: [error.message]
            };
        }
    }
}

module.exports = OrderMapper;

