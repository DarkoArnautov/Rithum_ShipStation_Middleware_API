/**
 * Order Mapper Service
 * Transforms Rithum orders to ShipStation order format
 * 
 * Uses ShipStation API v2 format
 * - Address fields: address_line1, city_locality, state_province, postal_code, country_code
 * - Endpoint: /v2/shipments (with create_sales_order: true to create an order)
 * - address_residential_indicator is required (defaults to "unknown" if not specified)
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

        // Use dscoOrderId as the primary unique identifier (for external_shipment_id)
        // This is required for reliable order retrieval from ShipStation
        // poNumber will be used as shipment_number for display purposes
        const externalOrderId = rithumOrder.dscoOrderId;
        const shipmentNumber = rithumOrder.poNumber || rithumOrder.dscoOrderId;

        if (!externalOrderId) {
            throw new Error('dscoOrderId is required for order identification');
        }

        const shipstationOrder = {
            orderNumber: externalOrderId, // Used as external_shipment_id (must be unique)
            shipmentNumber: shipmentNumber, // Used as shipment_number (for display, can use poNumber)
            orderDate: this.mapOrderDate(rithumOrder),
            orderStatus: this.mapOrderStatus(rithumOrder.dscoStatus),
            amountPaid: this.calculateAmountPaid(rithumOrder),
            currencyCode: this.getCurrencyCode(rithumOrder),
            customerUsername: this.getCustomerName(rithumOrder.shipping),
            shipTo: this.mapShippingAddress(rithumOrder.shipping || rithumOrder.shipTo),
            items: this.mapLineItems(rithumOrder.lineItems || [])
        };

        // Optional fields - only include if they have values
        if (rithumOrder.shipByDate) {
            shipstationOrder.shipByDate = rithumOrder.shipByDate;
        }

        // Store original order identifiers for tracking
        if (rithumOrder.dscoOrderId) {
            shipstationOrder.orderKey = rithumOrder.dscoOrderId;
        }

        // Financial breakdown (separate shipping and tax as shown in ShipStation UI)
        if (rithumOrder.shippingSurcharge !== null && rithumOrder.shippingSurcharge !== undefined) {
            shipstationOrder.shippingPaid = parseFloat(rithumOrder.shippingSurcharge) || 0;
        }

        if (rithumOrder.amountOfSalesTaxCollected !== null && rithumOrder.amountOfSalesTaxCollected !== undefined) {
            shipstationOrder.taxPaid = parseFloat(rithumOrder.amountOfSalesTaxCollected) || 0;
        }

        // Gift flag (shown in ShipStation UI)
        if (rithumOrder.giftFlag !== null && rithumOrder.giftFlag !== undefined) {
            shipstationOrder.isGift = rithumOrder.giftFlag;
        }

        // Shipping instructions (maps to notes_from_buyer in ShipStation)
        if (rithumOrder.shipInstructions) {
            shipstationOrder.notesFromBuyer = rithumOrder.shipInstructions;
        }

        // Gift message
        if (rithumOrder.giftMessage) {
            shipstationOrder.notesForGift = rithumOrder.giftMessage;
        }

        // Shipping service information (for ShipStation shipment)
        // Map Rithum shipping service code to ShipStation service_code format
        // Note: This is informational only. When labels are created, ShipStation uses carrier_id + service_code
        // Field name: requested_shipment_service (per ShipStation API v2 spec)
        if (rithumOrder.requestedShippingServiceLevelCode || rithumOrder.shippingServiceLevelCode) {
            shipstationOrder.requestedShipmentService = this.mapShippingService(
                rithumOrder.requestedShippingServiceLevelCode || rithumOrder.shippingServiceLevelCode,
                rithumOrder.requestedShipCarrier || rithumOrder.shipCarrier,
                rithumOrder.requestedShipMethod || rithumOrder.shipMethod
            );
        }

        // Custom fields for tracking
        if (rithumOrder.channel) {
            shipstationOrder.customField1 = rithumOrder.channel;
        }

        // Required: Store Rithum order ID in customField2 for tracking
        if (rithumOrder.dscoOrderId) {
            shipstationOrder.customField2 = rithumOrder.dscoOrderId;
        }

        // Store PO number in custom field for reference
        if (rithumOrder.poNumber) {
            shipstationOrder.customField3 = rithumOrder.poNumber;
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
     * Calculate total amount paid for the order
     * @param {Object} rithumOrder - Order from Rithum
     * @returns {number} Total amount paid
     */
    calculateAmountPaid(rithumOrder) {
        // Use extendedExpectedCostTotal as base (product cost)
        let amount = parseFloat(rithumOrder.extendedExpectedCostTotal) || 0;
        
        // Add shipping if available
        if (rithumOrder.shippingSurcharge !== null && rithumOrder.shippingSurcharge !== undefined) {
            amount += parseFloat(rithumOrder.shippingSurcharge) || 0;
        }
        
        // Add tax if available
        if (rithumOrder.amountOfSalesTaxCollected !== null && rithumOrder.amountOfSalesTaxCollected !== undefined) {
            amount += parseFloat(rithumOrder.amountOfSalesTaxCollected) || 0;
        }
        
        // Fallback to orderTotalAmount if available
        if (amount === 0 && rithumOrder.orderTotalAmount !== null && rithumOrder.orderTotalAmount !== undefined) {
            amount = parseFloat(rithumOrder.orderTotalAmount) || 0;
        }
        
        return amount;
    }

    /**
     * Get currency code for the order
     * @param {Object} rithumOrder - Order from Rithum
     * @returns {string} Currency code (default: USD)
     */
    getCurrencyCode(rithumOrder) {
        if (rithumOrder.currencyCode) {
            return rithumOrder.currencyCode.toUpperCase();
        }
        if (rithumOrder.consumerOrderCurrencyCode) {
            return rithumOrder.consumerOrderCurrencyCode.toUpperCase();
        }
        return 'USD';
    }

    /**
     * Map Rithum shipping service level code to ShipStation service format
     * @param {string} serviceLevelCode - Service level code from Rithum (e.g., "GCG")
     * @param {string} carrier - Carrier name from Rithum (e.g., "Generic")
     * @param {string} method - Shipping method from Rithum (e.g., "Ground")
     * @returns {string} ShipStation service code or display name
     */
    mapShippingService(serviceLevelCode, carrier, method) {
        if (!serviceLevelCode) {
            return null;
        }

        // Map common service level codes to ShipStation service codes
        // GCG (Generic Carrier Ground) typically maps to USPS Ground Advantage
        const serviceMap = {
            'GCG': 'usps_ground_advantage', // Generic Carrier Ground -> USPS Ground Advantage
            'GCP': 'usps_priority_mail',    // Generic Carrier Priority
            'GCE': 'usps_priority_mail_express', // Generic Carrier Express
            'FEDEX_GROUND': 'fedex_ground',
            'FEDEX_2_DAY': 'fedex_2_day',
            'FEDEX_OVERNIGHT': 'fedex_overnight',
            'UPS_GROUND': 'ups_ground',
            'UPS_2ND_DAY': 'ups_2nd_day_air',
            'UPS_NEXT_DAY': 'ups_next_day_air'
        };

        // Try to find mapping by service level code
        if (serviceMap[serviceLevelCode.toUpperCase()]) {
            return serviceMap[serviceLevelCode.toUpperCase()];
        }

        // Fallback: construct service name from carrier and method
        // This will be used as a tag or in notes if service code mapping isn't available
        const carrierName = (carrier || 'Generic').toLowerCase();
        const methodName = (method || 'Ground').toLowerCase();
        
        // Return a display-friendly service name
        if (carrierName === 'generic' && methodName === 'ground') {
            return 'usps_ground_advantage'; // Default assumption for Generic Ground
        }

        return `${carrierName}_${methodName}`;
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
     * Map shipping address from Rithum to ShipStation v2 API format
     * @param {Object} shipping - Shipping address from Rithum
     * @returns {Object} ShipStation shipping address (v2 format)
     */
    mapShippingAddress(shipping) {
        if (!shipping) {
            throw new Error('Shipping address is required');
        }

        const address = {
            name: this.getCustomerName(shipping),
            address_line1: shipping.address1 || '',
            city_locality: shipping.city || '',
            state_province: shipping.state || shipping.region || '',
            postal_code: shipping.postal || '',
            country_code: shipping.country || 'US',
            address_residential_indicator: this.getAddressResidentialIndicator(shipping)
        };

        // Phone is required for ShipStation v2 API
        address.phone = shipping.phone || '000-000-0000';

        // Address line 2 (optional)
        const addressLine2 = this.getStreet2(shipping);
        if (addressLine2) {
            address.address_line2 = addressLine2;
        }

        // Email (optional)
        if (shipping.email) {
            address.email = shipping.email;
        }

        // Company name (optional)
        if (shipping.companyName || shipping.company) {
            address.company_name = shipping.companyName || shipping.company;
        }

        return address;
    }

    /**
     * Get second address line if available
     * @param {Object} shipping - Shipping address
     * @returns {string|null} Second address line
     */
    getStreet2(shipping) {
        if (shipping.address2) {
            return shipping.address2;
        }
        if (shipping.address && Array.isArray(shipping.address) && shipping.address.length > 1) {
            return shipping.address[1];
        }
        return null;
    }

    /**
     * Determine address residential indicator
     * @param {Object} shipping - Shipping address
     * @returns {string} "yes", "no", or "unknown"
     */
    getAddressResidentialIndicator(shipping) {
        // If explicitly provided, use it
        if (shipping.addressResidentialIndicator) {
            const indicator = shipping.addressResidentialIndicator.toLowerCase();
            if (['yes', 'no', 'unknown'].includes(indicator)) {
                return indicator;
            }
        }

        // Default to "unknown" if not specified
        // This is required by ShipStation v2 API
        return 'unknown';
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
                // Use quantity if acceptedQuantity is 0 or not set (for new orders)
                const quantity = this.getItemQuantity(item);
                return quantity > 0;
            })
            .map((item, index) => {
                const mappedItem = {
                    sku: this.getItemSku(item, index),
                    name: item.title || 'Unknown Item',
                    quantity: this.getItemQuantity(item),
                    unitPrice: this.getItemPrice(item)
                };

                // Add external order item ID for tracking
                if (item.dscoItemId) {
                    mappedItem.externalOrderItemId = String(item.dscoItemId);
                }

                // Add personalization as option if present
                if (item.personalization) {
                    mappedItem.options = [{
                        name: 'Personalization',
                        value: String(item.personalization)
                    }];
                }

                // Add tax amount if available
                if (item.taxAmount !== null && item.taxAmount !== undefined) {
                    mappedItem.taxAmount = parseFloat(item.taxAmount) || 0;
                }

                return mappedItem;
            });
    }

    /**
     * Get quantity for line item with proper fallback logic
     * @param {Object} item - Line item from Rithum
     * @returns {number} Quantity
     */
    getItemQuantity(item) {
        // For new orders, acceptedQuantity may be 0, so use quantity instead
        // If acceptedQuantity is > 0, use it (order has been accepted)
        // Otherwise, use quantity (original order quantity)
        if (item.acceptedQuantity !== null && item.acceptedQuantity !== undefined && item.acceptedQuantity > 0) {
            return item.acceptedQuantity;
        }
        return item.quantity || 0;
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
        // poNumber or dscoOrderId is required for orderNumber
        if (!rithumOrder.poNumber && !rithumOrder.dscoOrderId) {
            errors.push('Missing poNumber or dscoOrderId (required for orderNumber)');
        }

        // Validate shipping address (v2 API requirements)
        // Check both shipping and shipTo fields
        const shippingAddress = rithumOrder.shipping || rithumOrder.shipTo;
        if (!shippingAddress) {
            errors.push('Missing shipping address (shipping or shipTo required)');
        } else {
            if (!shippingAddress.address1) {
                errors.push('Missing shipping.address1 (required for address_line1)');
            }
            if (!shippingAddress.city) {
                errors.push('Missing shipping.city (required for city_locality)');
            }
            if (!shippingAddress.state && !shippingAddress.region) {
                errors.push('Missing shipping.state or shipping.region (required for state_province)');
            }
            if (!shippingAddress.postal) {
                errors.push('Missing shipping.postal (required for postal_code)');
            }
            // Phone is required in v2 API (will use placeholder if missing)
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

        // Skip cancelled orders (check both legacy dscoStatus and new dscoLifecycle)
        if (rithumOrder.dscoStatus === 'cancelled' || rithumOrder.dscoLifecycle === 'cancelled') {
            console.log(`Skipping cancelled order: ${rithumOrder.dscoOrderId}`);
            return false;
        }

        // Skip already shipped orders (for new order sync)
        if (rithumOrder.dscoStatus === 'shipped') {
            console.log(`Skipping already shipped order: ${rithumOrder.dscoOrderId}`);
            return false;
        }

        // Check dscoLifecycle status first (new field), fallback to dscoStatus (deprecated)
        const lifecycle = rithumOrder.dscoLifecycle;
        const legacyStatus = rithumOrder.dscoStatus;
        
        if (lifecycle) {
            // New lifecycle field takes priority
            // Only process acknowledged orders (not created)
            if (lifecycle !== 'acknowledged') {
                console.log(`Skipping order with lifecycle ${lifecycle}: ${rithumOrder.dscoOrderId}`);
                return false;
            }
        } else if (legacyStatus) {
            // Fallback to legacy status field for backward compatibility
            // For legacy status, only process 'shipment_pending' (equivalent to acknowledged)
            if (legacyStatus !== 'shipment_pending') {
                console.log(`Skipping order with status ${legacyStatus}: ${rithumOrder.dscoOrderId}`);
                return false;
            }
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

