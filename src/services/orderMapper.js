const fs = require('fs');
const path = require('path');

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
    constructor() {
        // Load SKU weight catalog
        this.skuWeights = this.loadSkuWeights();
    }

    /**
     * Load SKU weight catalog from JSON file
     * @returns {Object} SKU weight catalog
     */
    loadSkuWeights() {
        try {
            const catalogPath = path.join(__dirname, '../../sku-weights.json');
            const catalogData = fs.readFileSync(catalogPath, 'utf8');
            return JSON.parse(catalogData);
        } catch (error) {
            console.warn('⚠️  Warning: Could not load SKU weight catalog:', error.message);
            console.warn('⚠️  Using default weights only');
            return {
                defaultWeight: { value: 2, unit: 'ounce' },
                skus: {}
            };
        }
    }

    /**
     * Get weight for a SKU from catalog
     * @param {string} sku - Product SKU
     * @returns {Object|null} Weight object {value, unit} or null
     */
    getSkuWeight(sku) {
        if (!sku || !this.skuWeights.skus) {
            return null;
        }
        
        const skuData = this.skuWeights.skus[sku];
        if (skuData && skuData.weight && skuData.unit) {
            return {
                value: skuData.weight,
                unit: skuData.unit
            };
        }
        
        return null;
    }
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

        // Add weight if available from line items
        const weight = this.calculateTotalWeight(rithumOrder.lineItems || []);
        if (weight) {
            shipstationOrder.weight = weight;
        }

        // Add package code (package type) first
        const packageCode = this.getPackageCode(rithumOrder);
        if (packageCode) {
            shipstationOrder.packageCode = packageCode;
        }

        // Note: Do NOT send dimensions when using a package_code
        // ShipStation uses predefined dimensions from the package type configuration
        // Only send dimensions if using 'package' (generic) without specific package type
        // if (packageCode === 'package') {
        //     const dimensions = this.getPackageDimensions(packageCode);
        //     if (dimensions) {
        //         shipstationOrder.dimensions = dimensions;
        //     }
        // }

        // Add service code (carrier + service combination)
        const serviceCode = this.getServiceCode(rithumOrder);
        if (serviceCode) {
            shipstationOrder.serviceCode = serviceCode;
        }

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
     * Calculate total weight from line items
     * Uses SKU catalog lookup if Rithum doesn't provide weight
     * @param {Array} lineItems - Line items from Rithum
     * @returns {Object|null} Weight object with value and unit, or null if no weight data
     */
    calculateTotalWeight(lineItems) {
        if (!Array.isArray(lineItems) || lineItems.length === 0) {
            return null;
        }

        let totalWeightInPounds = 0;
        let hasWeight = false;
        let skuLookupCount = 0;

        for (const item of lineItems) {
            const quantity = this.getItemQuantity(item);
            let weightInPounds = 0;
            
            // First, try to get weight from Rithum line item
            if (item.weight && item.weight > 0) {
                weightInPounds = parseFloat(item.weight);

                // Convert to pounds if needed
                if (item.weightUnits) {
                    const unit = item.weightUnits.toLowerCase();
                    if (unit === 'kg' || unit === 'kilogram' || unit === 'kilograms') {
                        weightInPounds = weightInPounds * 2.20462; // kg to lbs
                    } else if (unit === 'oz' || unit === 'ounce' || unit === 'ounces') {
                        weightInPounds = weightInPounds / 16; // oz to lbs
                    } else if (unit === 'g' || unit === 'gram' || unit === 'grams') {
                        weightInPounds = weightInPounds * 0.00220462; // g to lbs
                    }
                    // Default to lbs if already in pounds or unspecified
                }

                totalWeightInPounds += weightInPounds * quantity;
                hasWeight = true;
            } else {
                // If no weight from Rithum, try SKU catalog lookup
                const sku = item.sku || item.partnerSku;
                const skuWeight = this.getSkuWeight(sku);
                
                if (skuWeight) {
                    weightInPounds = parseFloat(skuWeight.value);
                    
                    // Convert SKU weight to pounds
                    const unit = skuWeight.unit.toLowerCase();
                    if (unit === 'kg' || unit === 'kilogram' || unit === 'kilograms') {
                        weightInPounds = weightInPounds * 2.20462;
                    } else if (unit === 'oz' || unit === 'ounce' || unit === 'ounces') {
                        weightInPounds = weightInPounds / 16;
                    } else if (unit === 'g' || unit === 'gram' || unit === 'grams') {
                        weightInPounds = weightInPounds * 0.00220462;
                    }
                    
                    totalWeightInPounds += weightInPounds * quantity;
                    hasWeight = true;
                    skuLookupCount++;
                    console.log(`   📦 Using SKU catalog weight for ${sku}: ${skuWeight.value} ${skuWeight.unit}`);
                }
            }
        }

        // If still no weight, use default weight
        if (!hasWeight || totalWeightInPounds <= 0) {
            if (this.skuWeights.defaultWeight) {
                const defaultWeight = this.skuWeights.defaultWeight.value;
                const defaultUnit = this.skuWeights.defaultWeight.unit;
                
                // Convert default weight to pounds
                let defaultWeightInPounds = parseFloat(defaultWeight);
                const unit = defaultUnit.toLowerCase();
                if (unit === 'oz' || unit === 'ounce' || unit === 'ounces') {
                    defaultWeightInPounds = defaultWeightInPounds / 16;
                } else if (unit === 'kg' || unit === 'kilogram') {
                    defaultWeightInPounds = defaultWeightInPounds * 2.20462;
                } else if (unit === 'g' || unit === 'gram') {
                    defaultWeightInPounds = defaultWeightInPounds * 0.00220462;
                }
                
                totalWeightInPounds = defaultWeightInPounds * lineItems.length;
                console.log(`   ⚠️  No weight data found, using default: ${defaultWeight} ${defaultUnit} per item`);
                hasWeight = true;
            }
        }

        if (!hasWeight || totalWeightInPounds <= 0) {
            console.log('   ⚠️  No weight data available and no default weight configured');
            return null;
        }

        // Return weight in ounces (ShipStation commonly uses ounces)
        const ounces = totalWeightInPounds * 16;
        const finalWeight = {
            value: Math.max(1, Math.ceil(ounces)), // Convert to oz, round up, min 1 oz
            unit: 'ounce'
        };
        
        if (skuLookupCount > 0) {
            console.log(`   ✅ Total weight calculated: ${finalWeight.value} ${finalWeight.unit} (${skuLookupCount} from SKU catalog)`);
        }
        
        return finalWeight;
    }

    /**
     * Get package dimensions based on package type
     * Provides default dimensions for common package types
     * @param {string} packageCode - Package code (e.g., 'flat_rate_padded_envelope')
     * @returns {Object|null} Dimensions object with length, width, height, unit or null
     */
    getPackageDimensions(packageCode) {
        if (!packageCode) {
            return null;
        }
        
        // USPS package dimensions (official sizes)
        const dimensionsMap = {
            // Flat Rate Envelopes
            'flat_rate_envelope': { length: 12.5, width: 9.5, height: 0.75, unit: 'inch' },
            'flat_rate_padded_envelope': { length: 12.5, width: 9.5, height: 1, unit: 'inch' },
            'flat_rate_legal_envelope': { length: 15, width: 9.5, height: 0.75, unit: 'inch' },
            
            // Flat Rate Boxes
            'small_flat_rate_box': { length: 8.625, width: 5.375, height: 1.625, unit: 'inch' },
            'medium_flat_rate_box': { length: 11.25, width: 8.75, height: 6, unit: 'inch' }, // Can also be 14x12x3.5
            'large_flat_rate_box': { length: 12.25, width: 12.25, height: 6, unit: 'inch' },
            
            // Regional Rate Boxes
            'regional_rate_box_a': { length: 10.125, width: 7.125, height: 5, unit: 'inch' },
            'regional_rate_box_b': { length: 12.25, width: 10.5, height: 5.5, unit: 'inch' },
            
            // Standard packages (approximate)
            'thick_envelope': { length: 10, width: 7, height: 1, unit: 'inch' },
            'letter': { length: 11.5, width: 6.125, height: 0.25, unit: 'inch' },
            'large_envelope_or_flat': { length: 15, width: 12, height: 0.75, unit: 'inch' },
            
            // FedEx packages (official sizes)
            'fedex_envelope': { length: 12.5, width: 9.5, height: 0.5, unit: 'inch' },
            'fedex_pak': { length: 15.5, width: 12, height: 1, unit: 'inch' },
            'fedex_small_box': { length: 12.25, width: 10.875, height: 1.5, unit: 'inch' },
            'fedex_medium_box': { length: 13.25, width: 11.5, height: 2.375, unit: 'inch' },
            'fedex_large_box': { length: 17.875, width: 12.375, height: 3, unit: 'inch' },
            'fedex_extra_large_box': { length: 20, width: 16, height: 12, unit: 'inch' },
            
            // UPS packages (official sizes)
            'ups_letter': { length: 12.5, width: 9.5, height: 0.5, unit: 'inch' },
            'ups_express_pak': { length: 16, width: 12.75, height: 1, unit: 'inch' },
            'ups_express_box_small': { length: 13, width: 11, height: 2, unit: 'inch' },
            'ups_express_box': { length: 16, width: 11, height: 3, unit: 'inch' },
            'ups_express_box_medium': { length: 16, width: 13, height: 3, unit: 'inch' },
            'ups__express_box_large': { length: 18, width: 13, height: 3, unit: 'inch' }
        };
        
        return dimensionsMap[packageCode] || null;
    }

    /**
     * Get package code (package type)
     * Optimized for jewelry/small items business
     * @param {Object} rithumOrder - Order from Rithum
     * @returns {string|null} Package code
     */
    getPackageCode(rithumOrder) {
        const weight = this.calculateTotalWeight(rithumOrder.lineItems || []);
        const carrier = (rithumOrder.requestedShipCarrier || rithumOrder.shipCarrier || '').toLowerCase();
        const serviceCode = (rithumOrder.requestedShippingServiceLevelCode || rithumOrder.shippingServiceLevelCode || '').toLowerCase();
        const method = (rithumOrder.requestedShipMethod || rithumOrder.shipMethod || '').toLowerCase();
        
        // If no weight available, use generic package
        if (!weight || weight.value <= 0) {
            return 'package';
        }
        
        const ounces = weight.value;
        
        // Determine if requesting Priority Mail or flat rate service
        const isPriorityOrFlatRate = serviceCode === 'pm' || 
                                     method.includes('priority') || 
                                     method.includes('flat rate');
        
        // USPS carrier (or Generic which defaults to USPS)
        if (carrier.includes('usps') || carrier.includes('postal') || carrier.includes('generic') || !carrier) {
            // For Priority Mail / Flat Rate service → use flat rate packages (better value)
            if (isPriorityOrFlatRate) {
                // Very light items (0-8 oz) - Perfect for jewelry
                if (ounces <= 8) {
                    return 'flat_rate_padded_envelope'; // Best protection + cost for small items
                }
                // Light items (8-16 oz)
                if (ounces <= 16) {
                    return 'small_flat_rate_box';
                }
                // Medium items (16-48 oz / 3 lbs)
                if (ounces <= 48) {
                    return 'medium_flat_rate_box';
                }
                // Heavy items (over 3 lbs)
                return 'large_flat_rate_box';
            }
            
            // For Ground Advantage / other services → use non-flat-rate packages
            // These are compatible with Ground Advantage and cost-effective
            if (ounces <= 4) {
                return 'thick_envelope'; // For very light items (jewelry)
            }
            if (ounces <= 16) {
                return 'package'; // Generic package (most flexible)
            }
            if (ounces <= 48) {
                return 'package'; // Still generic package
            }
            // Heavy items
            return 'large_package'; // For items > 3 lbs
        }
        
        // FedEx carrier
        if (carrier.includes('fedex')) {
            // Very light items (0-8 oz)
            if (ounces <= 8) {
                return 'fedex_envelope';
            }
            // Light items (8-16 oz)
            if (ounces <= 16) {
                return 'fedex_small_box';
            }
            // Medium items (16-32 oz / 2 lbs)
            if (ounces <= 32) {
                return 'fedex_medium_box';
            }
            // Heavy items
            return 'fedex_large_box';
        }
        
        // UPS carrier
        if (carrier.includes('ups')) {
            // Very light items (0-8 oz)
            if (ounces <= 8) {
                return 'ups_express_pak';
            }
            // Light items (8-16 oz)
            if (ounces <= 16) {
                return 'ups_express_box_small';
            }
            // Medium items
            if (ounces <= 32) {
                return 'ups_express_box';
            }
            // Heavy items
            return 'ups_express_box_medium';
        }
        
        // Default to generic package for unknown carriers
        return 'package';
    }

    /**
     * Get service code from Rithum shipping information
     * Maps Rithum shipping service to ShipStation service code
     * Based on available services in your ShipStation account (see list-carriers-services.js)
     * 
     * IMPORTANT: Flat rate packages require Priority Mail service, not Ground Advantage
     * 
     * @param {Object} rithumOrder - Order from Rithum
     * @returns {string|null} Service code (e.g., 'usps_ground_advantage', 'fedex_ground')
     */
    getServiceCode(rithumOrder) {
        const carrier = (rithumOrder.requestedShipCarrier || rithumOrder.shipCarrier || '').toLowerCase();
        const serviceCode = (rithumOrder.requestedShippingServiceLevelCode || rithumOrder.shippingServiceLevelCode || '').toLowerCase();
        const method = (rithumOrder.requestedShipMethod || rithumOrder.shipMethod || '').toLowerCase();

        // Check if using flat rate package (requires Priority Mail)
        const packageCode = this.getPackageCode(rithumOrder);
        const isFlatRate = packageCode && packageCode.includes('flat_rate');

        // Map Rithum carrier + service to ShipStation service codes
        // Note: Based on actual services available in your ShipStation account
        
        // USPS mappings (Available: usps_priority_mail, usps_ground_advantage)
        if (carrier.includes('usps') || carrier.includes('postal') || carrier.includes('generic') || !carrier) {
            // IMPORTANT: Flat rate packages MUST use Priority Mail service
            if (isFlatRate) {
                return 'usps_priority_mail';
            }
            
            // Rithum service codes:
            // - GCG = Ground Commercial Ground → usps_ground_advantage
            // - PM = Priority Mail → usps_priority_mail
            if (serviceCode === 'gcg' || method.includes('ground')) {
                return 'usps_ground_advantage';
            }
            if (serviceCode === 'pm' || method.includes('priority')) {
                return 'usps_priority_mail';
            }
            // Default USPS to ground advantage (most common/cheapest)
            return 'usps_ground_advantage';
        }

        // FedEx mappings (32 services available - see list-carriers-services.js for full list)
        if (carrier.includes('fedex') || carrier.includes('fed ex')) {
            // Ground services
            if (method.includes('ground') || serviceCode.includes('gnd') || serviceCode.includes('ground')) {
                return 'fedex_ground';
            }
            if (method.includes('home delivery')) {
                return 'fedex_home_delivery';
            }
            
            // 2-day services
            if (method.includes('2day') || method.includes('2 day')) {
                if (method.includes('am')) {
                    return 'fedex_2day_am';
                }
                return 'fedex_2day';
            }
            
            // Overnight services
            if (method.includes('overnight') || method.includes('next day')) {
                if (method.includes('first') || method.includes('early')) {
                    return 'fedex_first_overnight';
                }
                if (method.includes('priority')) {
                    return 'fedex_priority_overnight';
                }
                return 'fedex_standard_overnight';
            }
            
            // Express services
            if (method.includes('express')) {
                if (method.includes('saver')) {
                    return 'fedex_express_saver';
                }
                return 'fedex_express_saver';
            }
            
            // Default FedEx
            return 'fedex_ground';
        }

        // UPS mappings (30 services available - see list-carriers-services.js for full list)
        if (carrier.includes('ups')) {
            // Ground services
            if (method.includes('ground')) {
                return 'ups_ground';
            }
            
            // 3-day service
            if (method.includes('3 day') || method.includes('3day') || method.includes('three day')) {
                return 'ups_3_day_select';
            }
            
            // 2-day services
            if (method.includes('2nd day') || method.includes('2 day') || method.includes('two day')) {
                if (method.includes('am')) {
                    return 'ups_2nd_day_air_am';
                }
                return 'ups_2nd_day_air';
            }
            
            // Next day / overnight services
            if (method.includes('next day') || method.includes('overnight')) {
                if (method.includes('early') || method.includes('am')) {
                    return 'ups_next_day_air_early_am';
                }
                if (method.includes('saver')) {
                    return 'ups_next_day_air_saver';
                }
                return 'ups_next_day_air';
            }
            
            // Default UPS
            return 'ups_ground';
        }

        // DHL Express
        if (carrier.includes('dhl')) {
            return 'dhl_express_worldwide';
        }

        // No matching service found - return null (ShipStation will use default)
        return null;
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

