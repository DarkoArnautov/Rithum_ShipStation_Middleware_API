require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { URL } = require('url');
const express = require('express');
const ShipStationClient = require('./src/services/shipstationClient');
const RithumClient = require('./src/services/rithumClient');
const { shipstationConfig, validateConfig: validateShipStationConfig } = require('./src/config/shipstationConfig');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

const TRACKING_FILE = path.join(__dirname, 'shipped_orders_tracking.json');
const PORT = process.env.PORT || process.env.WEBHOOK_PORT || 3001;

/**
 * Map ShipStation carrier and service codes to Rithum shipping method codes
 * Based on Rithum's allowed values: ASEE, ASEP, ASEL, ASET, FECG, FEHD, FESP, ONCG, PSDD, UPCG, UPSV, UPSP, USGA, USPM
 */
function mapToRithumShippingMethod(carrierCode, serviceCode) {
    // Normalize inputs
    const carrier = String(carrierCode || '').toLowerCase().trim();
    const service = String(serviceCode || '').toLowerCase().trim();
    
    // Debug logging
    console.log(`   🔍 Mapping carrier/service: "${carrierCode}" / "${serviceCode}"`);
    console.log(`      Normalized: "${carrier}" / "${service}"`);
    
    // If service code already looks like a valid Rithum code (4 uppercase letters), return it
    // This handles cases where the service might already be a Rithum code
    const validRithumCodes = ['ASEE', 'ASEP', 'ASEL', 'ASET', 'FECG', 'FEHD', 'FESP', 'ONCG', 'PSDD', 'UPCG', 'UPSV', 'UPSP', 'USGA', 'USPM'];
    const upperService = String(serviceCode || '').toUpperCase().trim();
    if (validRithumCodes.includes(upperService)) {
        console.log(`      ✅ Service code is already a valid Rithum code: ${upperService}`);
        return upperService;
    }
    
    // UPS mappings
    if (carrier === 'ups' || carrier.includes('ups') || service.includes('ups')) {
        if (service.includes('ground')) return 'UPCG'; // UPS Ground
        if (service.includes('next_day') || service.includes('nextday') || service.includes('overnight')) return 'UPSV'; // UPS Next Day Air
        if (service.includes('2nd_day') || service.includes('2day')) return 'UPSP'; // UPS 2nd Day Air
        return 'UPCG'; // Default UPS to Ground
    }
    
    // USPS mappings
    if (carrier === 'usps' || service.includes('usps')) {
        if (service.includes('priority')) return 'USPM'; // USPS Priority Mail
        if (service.includes('first') || service.includes('fcm')) return 'USPM'; // USPS First Class -> Priority
        return 'USGA'; // USPS Ground Advantage or other
    }
    
    // FedEx mappings
    if (carrier === 'fedex' || carrier === 'fedex_uk' || service.includes('fedex')) {
        if (service.includes('ground') || service.includes('home_delivery')) return 'FECG'; // FedEx Ground
        if (service.includes('2day') || service.includes('2_day')) return 'FEHD'; // FedEx 2Day
        if (service.includes('express') || service.includes('overnight') || service.includes('priority')) return 'FESP'; // FedEx Express/Priority
        return 'FECG'; // Default FedEx to Ground
    }
    
    // OnTrac mappings
    if (carrier === 'ontrac' || service.includes('ontrac')) {
        return 'ONCG'; // OnTrac Ground
    }
    
    // Default fallback - use UPS Ground as safe default
    console.warn(`   ⚠️  Unknown carrier/service combination: ${carrier}/${service}, defaulting to UPCG`);
    return 'UPCG';
}

function normalizeEventType(rawType) {
    if (!rawType) {
        return null;
    }
    return String(rawType).toLowerCase();
}

function extractFulfillmentFromLegacyPayload(webhookData) {
    if (!webhookData || !webhookData.resource_url) {
        return null;
    }

    try {
        const resourceUrl = new URL(webhookData.resource_url);
        const shipmentId = resourceUrl.searchParams.get('shipment_id');
        const fulfillmentId = resourceUrl.searchParams.get('fulfillment_id');

        return {
            shipment_id: shipmentId,
            fulfillment_id: fulfillmentId,
            tracking_number: webhookData.tracking_number || webhookData.tracking || null,
            carrier_name: webhookData.carrier_name || webhookData.carrier || null,
            carrier_id: webhookData.carrier_id || null
        };
    } catch (error) {
        console.warn('⚠️  Could not parse resource_url:', error.message);
        return null;
    }
}

async function updateRithumOrderTracking(rithumClient, rithumOrderId, shipment, trackingInfo, shipstationClient = null, shipmentId = null) {
    if (!rithumClient) {
        throw new Error('Rithum client not available');
    }

    if (!rithumOrderId) {
        throw new Error('Missing Rithum order ID');
    }

    const trackingNumber = trackingInfo?.tracking_number || shipment.tracking_number;
    
    // Try to get actual label cost from ShipStation
    let labelCost = 0;
    if (shipstationClient && shipmentId) {
        try {
            console.log(`   💰 Fetching label cost from ShipStation...`);
            const label = await shipstationClient.getLabelByShipmentId(shipmentId);
            if (label && label.shipment_cost && label.shipment_cost.amount) {
                labelCost = label.shipment_cost.amount;
                console.log(`   💰 Label Cost: $${labelCost} (from ShipStation label)`);
            }
        } catch (error) {
            console.warn(`   ⚠️  Could not fetch label cost: ${error.message}`);
        }
    }
    
    // Variable to store the requested shipping method from Rithum order
    let requestedShippingServiceLevelCode = null;
    // Variable to store the Rithum order for accessing poNumber and other fields
    let rithumOrder = null;
    
    // Check if order already has this shipment (avoid duplicates)
    console.log(`   🔍 Checking if shipment already exists in Rithum order ${rithumOrderId}...`);
    try {
        const until = new Date(Date.now() - 5000).toISOString();
        const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
        
        // Fetch orders and search for our specific order
        let scrollId = null;
        let existingOrder = null;
        let pageCount = 0;
        const maxPages = 10; // Limit search to 10 pages max
        
        while (!existingOrder && pageCount < maxPages) {
            pageCount++;
            
            const params = scrollId 
                ? { scrollId }
                : { ordersUpdatedSince: since, until: until, ordersPerPage: 100 };
            
            const orderResponse = await rithumClient.makeRequest('GET', '/order/page', null, params);
            const orders = orderResponse?.orders || [];
            
            // Look for our order in this page
            existingOrder = orders.find(o => o.dscoOrderId === String(rithumOrderId));
            
            // If not found and there's more pages, continue
            if (!existingOrder && orderResponse.scrollId) {
                scrollId = orderResponse.scrollId;
            } else {
                break;
            }
        }
        
        if (existingOrder) {
            // Store the order for later use (poNumber, etc.)
            rithumOrder = existingOrder;
            
            console.log(`   ✅ Found order ${rithumOrderId} - lifecycle: ${existingOrder.dscoLifecycle}`);
            console.log(`      PO Number: ${existingOrder.poNumber || 'N/A'}`);
            console.log(`      Requested shipping: ${existingOrder.requestedShippingServiceLevelCode || 'N/A'}`);
            
            // Check if order is in wrong lifecycle state (not acknowledged or completed)
            const validLifecycles = ['acknowledged', 'completed'];
            if (!validLifecycles.includes(existingOrder.dscoLifecycle)) {
                console.log(`   ⏭️  SKIPPING: Order lifecycle is "${existingOrder.dscoLifecycle}" (must be acknowledged or completed)`);
                console.log(`      Order has not been acknowledged by supplier yet - cannot add shipment`);
                return {
                    statusResponse: { skipped: true, reason: `Invalid lifecycle: ${existingOrder.dscoLifecycle}` },
                    trackingNumber,
                    carrier: null,
                    shipMethod: null,
                    shipDate: null,
                    lineItemCount: 0,
                    requestedShippingMethod: existingOrder.requestedShippingServiceLevelCode
                };
            }
            
            // Check if order lifecycle is already completed
            if (existingOrder.dscoLifecycle === 'completed') {
                // Check if tracking number already exists
                const existingPackages = existingOrder.packages || [];
                const duplicatePackage = existingPackages.find(pkg => pkg.trackingNumber === trackingNumber);
                
                if (duplicatePackage) {
                    console.log(`   ⏭️  SKIPPING: Tracking ${trackingNumber} already exists on completed order`);
                    return {
                        statusResponse: { skipped: true, reason: 'Duplicate tracking on completed order' },
                        trackingNumber,
                        carrier: duplicatePackage.shipCarrier,
                        shipMethod: duplicatePackage.shipMethod,
                        shipDate: duplicatePackage.shipDate,
                        lineItemCount: duplicatePackage.items?.length || 0
                    };
                }
            } else {
                // Order not completed yet - check for duplicate tracking anyway
                const existingPackages = existingOrder.packages || [];
                const duplicatePackage = existingPackages.find(pkg => pkg.trackingNumber === trackingNumber);
                
                if (duplicatePackage) {
                    console.log(`   ⏭️  SKIPPING: Tracking ${trackingNumber} already exists on order`);
                    return {
                        statusResponse: { skipped: true, reason: 'Tracking number already exists' },
                        trackingNumber,
                        carrier: duplicatePackage.shipCarrier,
                        shipMethod: duplicatePackage.shipMethod,
                        shipDate: duplicatePackage.shipDate,
                        lineItemCount: duplicatePackage.items?.length || 0
                    };
                }
            }
            
            console.log(`   ✅ Order lifecycle valid and no duplicates - proceeding with shipment creation`);
            
            // Store the requested shipping method from the order to use instead of ShipStation's method
            requestedShippingServiceLevelCode = existingOrder.requestedShippingServiceLevelCode;
        } else {
            console.log(`   ⚠️  Order ${rithumOrderId} not found in recent orders`);
            console.log(`      This may fail if order is not in "acknowledged" lifecycle state`);
            console.log(`      Proceeding with shipment creation anyway...`);
        }
    } catch (error) {
        console.warn(`   ⚠️  Could not check for existing shipment: ${error.message}`);
        console.warn(`      This may fail if order is not in "acknowledged" lifecycle state`);
        console.warn(`      Proceeding with shipment creation anyway...`);
    }
    
    // Extract carrier information
    const carrierName = trackingInfo?.carrier_name || shipment.carrier?.name || shipment.carrier_name || shipment.carrier_id || null;
    const carrierCode = trackingInfo?.carrier_code || shipment.carrier?.carrier_code || shipment.carrier_code || null;
    
    // Extract ship method/service
    const shipMethod = trackingInfo?.service_code || shipment.carrier?.service || shipment.service_code || shipment.ship_method || null;
    
    // Debug logging for extracted values
    console.log(`   📋 Extracted from shipment:`);
    console.log(`      Carrier Name: ${carrierName}`);
    console.log(`      Carrier Code: ${carrierCode}`);
    console.log(`      Ship Method: ${shipMethod}`);
    
    // Ship date should be the date the label was created or today, NOT a future date
    let shipDate = trackingInfo?.ship_date || shipment.ship_date;
    
    // If the ship date is in the future or missing, use today's date
    if (!shipDate || new Date(shipDate) > new Date()) {
        shipDate = new Date().toISOString();
        console.log(`   ⚠️  Ship date was future/missing, using today: ${shipDate}`);
    }

    // Try to extract line items with identifiers
    const lineItems = (shipment.items || []).map(item => {
        const rawQuantity = item.quantity || item.ordered_quantity || 1;
        const quantity = Number(rawQuantity);
        if (!quantity || Number.isNaN(quantity) || quantity <= 0) {
            return null;
        }

        const lineItem = { quantity };
        
        // Try to get dscoItemId from various fields
        const dscoItemId = item.external_order_item_id || item.sales_order_item_id || item.dsco_item_id || item.dscoItemId;
        if (dscoItemId != null && dscoItemId !== '') {
            lineItem.dscoItemId = String(dscoItemId);
        }

        // ALWAYS include SKU (REQUIRED by Rithum API even if dscoItemId is present)
        if (item.sku) {
            lineItem.sku = String(item.sku);
        }
        
        // Include other identifiers as well
        if (item.partner_sku || item.partnerSku) {
            lineItem.partnerSku = String(item.partner_sku || item.partnerSku);
        }
        if (item.upc) {
            lineItem.upc = String(item.upc);
        }

        // Only include line item if it has at least one identifier
        if (!lineItem.dscoItemId && !lineItem.sku && !lineItem.partnerSku && !lineItem.upc) {
            return null;
        }

        return lineItem;
    }).filter(Boolean);

    const dscoOrderId = String(rithumOrderId);

    // Build shipment object to add to the order
    // This will change the order lifecycle from "acknowledged" to "completed"
    const shipmentData = {
        dscoOrderId,
        shipments: [
            {
                trackingNumber: trackingNumber || 'NO_TRACKING',
                lineItems: []  // REQUIRED field according to Rithum API spec
            }
        ]
    };
    
    // Add poNumber if we have the Rithum order (REQUIRED for singleShipment endpoint)
    if (rithumOrder && rithumOrder.poNumber) {
        shipmentData.poNumber = rithumOrder.poNumber;
        console.log(`   📋 Using PO Number from order: ${rithumOrder.poNumber}`);
    } else {
        console.log(`   ⚠️  WARNING: No PO Number available (order not fetched or missing poNumber)`);
    }

    // Add line items to the shipment
    if (lineItems.length > 0) {
        shipmentData.shipments[0].lineItems = lineItems.map(item => {
            const shipmentItem = {
                quantity: item.quantity
            };
            
            // Add item identifiers (at least one is required)
            if (item.dscoItemId) shipmentItem.dscoItemId = item.dscoItemId;
            if (item.sku) shipmentItem.sku = item.sku;
            if (item.partnerSku) shipmentItem.partnerSku = item.partnerSku;
            if (item.upc) shipmentItem.upc = item.upc;
            
            return shipmentItem;
        });
        console.log(`   📦 Creating shipment with ${lineItems.length} line item(s)`);
    } else {
        // No identifiable line items - we can't create a shipment without them
        // Rithum requires at least one line item with quantity and identifier
        throw new Error('Cannot create shipment: No identifiable line items found. Shipment requires at least one item with dscoItemId, sku, partnerSku, or upc.');
    }

    // Add REQUIRED shipment details
    // Rithum requires: trackingNumber, shipDate, shipMethod, shipCarrier, shipCost, shipWeight, shipWeightUnits
    
    // Ship Date (REQUIRED)
    if (shipDate) {
        shipmentData.shipments[0].shipDate = shipDate;
    }
    
    // Ship Cost - Use label cost if available, otherwise try shipment fields
    // Label cost is the actual cost charged by the carrier for the label
    const shipCost = labelCost || shipment.shipping_amount?.amount || shipment.ship_cost || shipment.cost || 0;
    shipmentData.shipments[0].shipCost = parseFloat(shipCost);
    if (labelCost) {
        console.log(`   💰 Ship Cost: $${shipCost} (from label)`);
    } else {
        console.log(`   💰 Ship Cost: $${shipCost} (from shipment or default)`);
    }
    
    // Ship Weight (REQUIRED) - Extract from shipment packages or total_weight
    let shipWeight = null;
    let shipWeightUnit = null;
    
    if (shipment.total_weight && shipment.total_weight.value) {
        shipWeight = shipment.total_weight.value;
        shipWeightUnit = shipment.total_weight.unit || 'ounce';
    } else if (shipment.weight && typeof shipment.weight === 'object') {
        shipWeight = shipment.weight.value || shipment.weight.amount;
        shipWeightUnit = shipment.weight.unit || 'ounce';
    } else if (shipment.weight) {
        shipWeight = shipment.weight;
        shipWeightUnit = 'ounce'; // Default
    } else if (shipment.packages && shipment.packages.length > 0) {
        // Get weight from first package
        const firstPackage = shipment.packages[0];
        if (firstPackage.weight) {
            if (typeof firstPackage.weight === 'object') {
                shipWeight = firstPackage.weight.value || firstPackage.weight.amount;
                shipWeightUnit = firstPackage.weight.unit || 'ounce';
            } else {
                shipWeight = firstPackage.weight;
                shipWeightUnit = 'ounce';
            }
        }
    }
    
    if (shipWeight !== null && shipWeight !== undefined) {
        shipmentData.shipments[0].shipWeight = parseFloat(shipWeight);
        
        // Convert weight unit to Rithum format
        // ShipStation uses: ounce, pound, gram, kilogram (singular, lowercase)
        // Rithum expects uppercase: OZ, LB, G, KG (matching test-sync-shipment.js format)
        const weightUnitMap = {
            'oz': 'OZ',
            'ounce': 'OZ',
            'ounces': 'OZ',
            'lb': 'LB',
            'lbs': 'LB',
            'pound': 'LB',
            'pounds': 'LB',
            'g': 'G',
            'gram': 'G',
            'grams': 'G',
            'kg': 'KG',
            'kilogram': 'KG',
            'kilograms': 'KG'
        };
        
        const normalizedUnit = weightUnitMap[String(shipWeightUnit).toLowerCase()] || 'OZ';
        shipmentData.shipments[0].shipWeightUnits = normalizedUnit;
        
        console.log(`   ⚖️  Ship Weight: ${shipWeight} ${normalizedUnit}`);
    } else {
        // Default weight if not available (required field)
        shipmentData.shipments[0].shipWeight = 1;
        shipmentData.shipments[0].shipWeightUnits = 'OZ';
        console.log(`   ⚖️  Ship Weight: 1 OZ (default - weight not found in shipment)`);
    }
    
    // Determine which shipping method to use
    // Priority: 1) Requested method from Rithum order (if valid), 2) Map from ShipStation carrier/service
    let rithumShippingMethod;
    
    // Valid Rithum shipping codes for shipments
    const validRithumCodes = ['ASEE', 'ASEP', 'ASEL', 'ASET', 'FECG', 'FEHD', 'FESP', 'ONCG', 'PSDD', 'UPCG', 'UPSV', 'UPSP', 'USGA', 'USPM'];
    
    if (requestedShippingServiceLevelCode && validRithumCodes.includes(requestedShippingServiceLevelCode)) {
        // Use the method that was originally requested in the order (if it's a valid shipment code)
        rithumShippingMethod = requestedShippingServiceLevelCode;
        console.log(`   📋 Using requested shipping method from order: ${rithumShippingMethod}`);
    } else {
        if (requestedShippingServiceLevelCode && !validRithumCodes.includes(requestedShippingServiceLevelCode)) {
            console.log(`   ⚠️  Order requested "${requestedShippingServiceLevelCode}" which is not valid for shipments`);
            console.log(`       Mapping based on carrier/service instead...`);
        }
        
        // Map ShipStation carrier/service to Rithum shipping method code
        // Rithum requires specific method codes: ASEE, ASEP, ASEL, ASET, FECG, FEHD, FESP, ONCG, PSDD, UPCG, UPSV, UPSP, USGA, USPM
        rithumShippingMethod = mapToRithumShippingMethod(carrierCode || carrierName, shipMethod);
        console.log(`   🔄 Mapped from ShipStation: ${shipMethod || 'N/A'} → ${rithumShippingMethod}`);
    }
    
    // Validate that we got a proper Rithum code (should be 4 characters)
    // If the mapping returned something that looks wrong, log detailed info
    if (!rithumShippingMethod || rithumShippingMethod.length !== 4) {
        console.warn(`   ⚠️  WARNING: Mapped shipping method looks invalid: "${rithumShippingMethod}"`);
        console.warn(`      Input Carrier: "${carrierCode || carrierName}"`);
        console.warn(`      Input Service: "${shipMethod}"`);
    }
    
    // Add shipping fields - Rithum requires BOTH carrierManifestId AND shippingServiceLevelCode
    // carrierManifestId: The carrier name (USPS, FedEx, UPS, etc.)
    // shippingServiceLevelCode: The service code (USGA, FECG, UPCG, etc.)
    // shipMethod: Human-readable method name (optional but recommended)
    
    // Map carrier name to Rithum's carrierManifestId format
    const carrierManifestIdMap = {
        'usps': 'USPS',
        'stamps_com': 'USPS',
        'fedex': 'FedEx',
        'fedex_uk': 'FedEx',
        'ups': 'UPS',
        'dhl_express': 'DHL',
        'ontrac': 'OnTrac'
    };
    
    const normalizedCarrier = (carrierName || carrierCode || '').toLowerCase();
    const carrierManifestId = carrierManifestIdMap[normalizedCarrier] || 
                               (carrierName || carrierCode || 'USPS').toUpperCase();
    
    // Map service code to human-readable method name
    const shipMethodMap = {
        'USGA': 'Ground Advantage',
        'USPM': 'Priority Mail',
        'FECG': 'FedEx Ground',
        'FEHD': 'FedEx 2Day',
        'FESP': 'FedEx Express',
        'UPCG': 'UPS Ground',
        'UPSV': 'UPS Next Day Air',
        'UPSP': 'UPS 2nd Day Air'
    };
    
    shipmentData.shipments[0].carrierManifestId = carrierManifestId;
    shipmentData.shipments[0].shippingServiceLevelCode = rithumShippingMethod;
    shipmentData.shipments[0].shipMethod = shipMethodMap[rithumShippingMethod] || 'Ground';
    shipmentData.shipments[0].shipCarrier = carrierManifestId;  // REQUIRED field - same as carrierManifestId
    
    console.log(`   📦 Carrier Manifest ID: ${carrierManifestId}`);
    console.log(`   🚚 Shipping Service Level Code: ${rithumShippingMethod}`);
    console.log(`   📮 Ship Method: ${shipmentData.shipments[0].shipMethod}`);
    console.log(`   🔍 DEBUG: Final shipment payload being sent to Rithum:`);
    console.log(`      shippingServiceLevelCode: "${shipmentData.shipments[0].shippingServiceLevelCode}"`);
    console.log(`      trackingNumber: "${shipmentData.shipments[0].trackingNumber}"`);
    console.log(`      shipWeight: ${shipmentData.shipments[0].shipWeight} ${shipmentData.shipments[0].shipWeightUnits}`);
    console.log(`      Full payload:`, JSON.stringify(shipmentData, null, 2));
    
    // Submit shipment to Rithum
    const statusResponse = await rithumClient.createShipments(shipmentData);
    
    // Log the requestId for tracking async validation results
    if (statusResponse && statusResponse.requestId) {
        console.log(`   📝 Rithum Request ID: ${statusResponse.requestId}`);
        console.log(`      ℹ️  Use this ID to check validation status in Rithum OrderChangeLog`);
    }

    return {
        statusResponse,
        trackingNumber,
        carrier: carrierName || carrierCode,
        shipMethod,
        shipDate,
        lineItemCount: lineItems.length
    };
}

async function loadTrackedOrders() {
    try {
        const data = await fs.readFile(TRACKING_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist yet - return empty structure
            return {
                trackedOrders: [],
                lastUpdated: null,
                totalTracked: 0
            };
        }
        throw error;
    }
}

/**
 * Save tracked orders to file
 */
async function saveTrackedOrders(data) {
    try {
        await fs.writeFile(TRACKING_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`\n💾 Tracked orders saved to: ${TRACKING_FILE}\n`);
    } catch (error) {
        console.error(`\n❌ Failed to save tracking file: ${error.message}`);
        throw error;
    }
}

async function extractRithumOrderId(shipment, shipstationClient = null) {
    let rithumOrderId = null;

    // Method 1: Check tags (customField2 becomes a tag with name = dscoOrderId)
    if (shipment.tags && Array.isArray(shipment.tags)) {
        const dscoTag = shipment.tags.find(tag => {
            const tagName = tag.name || '';
            // Check if it's a numeric string (likely dscoOrderId) or contains dsco
            return tagName.match(/^\d+$/) || tagName.toLowerCase().includes('dsco');
        });
        if (dscoTag) {
            rithumOrderId = dscoTag.name;
            console.log(`   🔗 Found Rithum Order ID in tags: ${rithumOrderId}`);
            return rithumOrderId;
        }
    }

    // Method 2: Check customField2 directly (if available in shipment)
    if (!rithumOrderId && shipment.customField2) {
        rithumOrderId = shipment.customField2;
        console.log(`   🔗 Found Rithum Order ID in customField2: ${rithumOrderId}`);
        return rithumOrderId;
    }

    // Method 3: Check sales_order if available (customField2 might be on the order)
    if (!rithumOrderId && shipment.sales_order_id && shipstationClient) {
        try {
            console.log(`   🔍 Checking sales_order for Rithum Order ID...`);
            const order = await shipstationClient.getOrderById(shipment.sales_order_id);
            
            // Check order tags
            if (order.tags && Array.isArray(order.tags)) {
                const dscoTag = order.tags.find(tag => {
                    const tagName = tag.name || '';
                    return tagName.match(/^\d+$/) || tagName.toLowerCase().includes('dsco');
                });
                if (dscoTag) {
                    rithumOrderId = dscoTag.name;
                    console.log(`   🔗 Found Rithum Order ID in sales_order tags: ${rithumOrderId}`);
                    return rithumOrderId;
                }
            }
            
            // Check order customField2
            if (order.customField2) {
                rithumOrderId = order.customField2;
                console.log(`   🔗 Found Rithum Order ID in sales_order customField2: ${rithumOrderId}`);
                return rithumOrderId;
            }
        } catch (error) {
            console.warn(`   ⚠️  Could not fetch sales_order to extract Rithum ID: ${error.message}`);
        }
    }

    // Method 4: Try to extract from external_shipment_id (if it's a dscoOrderId)
    if (!rithumOrderId && shipment.external_shipment_id) {
        const externalId = shipment.external_shipment_id;
        
        // Check if external_shipment_id is numeric (likely dscoOrderId)
        if (externalId.match(/^\d+$/)) {
            rithumOrderId = externalId;
            console.log(`   🔗 Found Rithum Order ID in external_shipment_id: ${rithumOrderId}`);
            return rithumOrderId;
        }
        
        // Handle test order IDs (format: 91026064154-790940)
        // Extract original ID by removing test prefix '9' and timestamp
        if (externalId.match(/^9\d+-\d+$/)) {
            // Extract the part between '9' prefix and '-timestamp'
            const match = externalId.match(/^9(\d+)-\d+$/);
            if (match && match[1]) {
                rithumOrderId = match[1];
                console.log(`   🔗 Found TEST Rithum Order ID in external_shipment_id: ${externalId}`);
                console.log(`      Extracted original ID: ${rithumOrderId}`);
                return rithumOrderId;
            }
        }
    }

    // Method 5: Try to extract from shipment_number (fallback - only if numeric)
    if (!rithumOrderId && shipment.shipment_number) {
        // Only use if it looks like a Rithum order ID (numeric)
        if (shipment.shipment_number.match(/^\d+$/)) {
            rithumOrderId = shipment.shipment_number;
            console.log(`   🔗 Found Rithum Order ID in shipment_number: ${rithumOrderId}`);
            return rithumOrderId;
        }
    }

    if (!rithumOrderId) {
        console.warn(`   ⚠️  Could not find Rithum Order ID in shipment`);
        console.warn(`      Tags: ${JSON.stringify(shipment.tags || [])}`);
        console.warn(`      External Shipment ID: ${shipment.external_shipment_id || 'N/A'}`);
        console.warn(`      Shipment Number: ${shipment.shipment_number || 'N/A'}`);
        console.warn(`      Sales Order ID: ${shipment.sales_order_id || 'N/A'}`);
        console.warn(`   💡 Note: This shipment may not have been created through the middleware.`);
        console.warn(`      Orders created via the middleware store dscoOrderId in tags/customField2.`);
    }

    return rithumOrderId;
}

/**
 * Process label_created_v2 webhook event
 * This is triggered when a label is created in ShipStation
 * 
 * Webhook payload structure:
 * {
 *   "resource_url": "https://api.shipstation.com/v2/labels?batch_id=se-300924711",
 *   "resource_type": "LABEL_CREATED_V2"
 * }
 */
async function processLabelCreatedWebhook(webhookData, shipstationClient, rithumClient) {
    try {
        let shipmentId = null;
        const shipmentData = webhookData.shipment || webhookData.data || webhookData.label?.shipment;
        if (shipmentData && shipmentData.shipment_id) {
            shipmentId = shipmentData.shipment_id;
        }
        
        if (!shipmentId && webhookData.resource_url) {
            try {
                const resourceUrl = new URL(webhookData.resource_url);
                
                const pathMatch = resourceUrl.pathname.match(/\/shipments\/([^\/]+)/);
                if (pathMatch) {
                    shipmentId = pathMatch[1];
                    console.log(`   ✅ Found shipment_id in resource_url path: ${shipmentId}`);
                }
                
                if (!shipmentId) {
                    shipmentId = resourceUrl.searchParams.get('shipment_id');
                }
                
                if (!shipmentId) {
                    const batchId = resourceUrl.searchParams.get('batch_id');
                    if (batchId) {
                        const labelsResponse = await shipstationClient.client.get('/v2/labels', {
                            params: { batch_id: batchId }
                        });
                        
                        const labels = labelsResponse.data?.labels || labelsResponse.data || [];
                        if (Array.isArray(labels) && labels.length > 0) {
                            shipmentId = labels[0].shipment_id;
                            console.log(`   ✅ Found shipment_id from batch labels: ${shipmentId}`);
                            
                            if (labels[0].tracking_number) {
                                console.log(`   ✅ Found tracking number in batch label: ${labels[0].tracking_number}`);
                                webhookData._labelTrackingNumber = labels[0].tracking_number;
                                webhookData._labelCarrierId = labels[0].carrier_id;
                                webhookData._labelCarrierCode = labels[0].carrier_code;
                            }
                        }
                    }
                }
            } catch (error) {
                console.warn('⚠️  Could not parse resource_url:', error.message);
            }
        }
        
        if (!shipmentId) {
            throw new Error('No shipment_id found in label_created_v2 webhook payload. Tried: shipment data, resource_url params, and batch labels.');
        }

        console.log(`\n🏷️  Processing label created webhook:`);
        const shipment = await shipstationClient.getShipmentById(shipmentId);
        let trackingInfo = await shipstationClient.getShipmentTracking(shipmentId);
        
        if (!trackingInfo.tracking_number) {
            // First, check if we already have tracking from batch labels
            if (webhookData._labelTrackingNumber) {
                console.log(`   ✅ Using tracking number from batch label: ${webhookData._labelTrackingNumber}`);
                trackingInfo.tracking_number = webhookData._labelTrackingNumber;
                if (webhookData._labelCarrierId && !trackingInfo.carrier_id) {
                    trackingInfo.carrier_id = webhookData._labelCarrierId;
                }
                if (webhookData._labelCarrierCode && !trackingInfo.carrier_name) {
                    trackingInfo.carrier_name = webhookData._labelCarrierCode;
                }
            } else {
                console.log(`   🔍 Tracking number not in shipment, checking labels...`);
                try {
                    // Fetch labels for this shipment
                    const labelsResponse = await shipstationClient.client.get('/v2/labels', {
                        params: { shipment_id: shipmentId }
                    });
                    
                    const labels = labelsResponse.data?.labels || labelsResponse.data || [];
                    if (Array.isArray(labels) && labels.length > 0) {
                        // Get tracking number from first label
                        const label = labels[0];
                        if (label.tracking_number) {
                            console.log(`   ✅ Found tracking number from label: ${label.tracking_number}`);
                            trackingInfo.tracking_number = label.tracking_number;
                            // Also update carrier info from label if available
                            if (label.carrier_id && !trackingInfo.carrier_id) {
                                trackingInfo.carrier_id = label.carrier_id;
                            }
                            if (label.carrier_code && !trackingInfo.carrier_name) {
                                trackingInfo.carrier_name = label.carrier_code;
                            }
                        } else {
                            console.log(`   ⚠️  Label exists but tracking number not yet available (may be populated later)`);
                        }
                    }
                } catch (error) {
                    console.warn('⚠️  Could not fetch labels for tracking number:', error.message);
                }
            }
        } else {
            console.log(`   ✅ Tracking number found in shipment: ${trackingInfo.tracking_number}`);
        }

        // Extract Rithum order ID
        const rithumOrderId = await extractRithumOrderId(shipment, shipstationClient);

        // Build tracked order information
        const trackedOrder = {
            timestamp: new Date().toISOString(),
            webhookEvent: 'label_created_v2',
            shipment: {
                shipment_id: shipment.shipment_id,
                shipment_number: shipment.shipment_number,
                external_shipment_id: shipment.external_shipment_id,
                shipment_status: shipment.shipment_status,
                sales_order_id: shipment.sales_order_id,
                created_at: shipment.created_at,
                modified_at: shipment.modified_at
            },
            tracking: {
                tracking_number: trackingInfo.tracking_number || null,
                carrier_id: trackingInfo.carrier_id || shipment.carrier_id,
                carrier_name: trackingInfo.carrier_name || shipment.carrier_name,
                ship_date: trackingInfo.ship_date || shipment.ship_date,
                estimated_delivery_date: trackingInfo.estimated_delivery_date || shipment.estimated_delivery_date,
                packages: trackingInfo.packages || shipment.packages || []
            },
            shipping: {
                ship_to: shipment.ship_to || null,
                ship_from: shipment.ship_from || null
            },
            rithumOrderId: rithumOrderId || null,
            rithumUpdated: false,
            rithumUpdate: {
                attempted: !!rithumClient && !!rithumOrderId,
                success: false,
                updatedAt: null,
                trackingNumber: null,
                carrier: null,
                error: null
            },
            note: rithumClient ? 'Label created - tracking captured - awaiting Rithum update' : 'Label created - tracking captured locally - Rithum client unavailable'
        };

        // Attempt to update Rithum with tracking information
        if (rithumClient && rithumOrderId) {
            try {
                const { statusResponse, trackingNumber: submittedTracking, carrier, lineItemCount } = await updateRithumOrderTracking(
                    rithumClient,
                    rithumOrderId,
                    shipment,
                    trackingInfo,
                    shipstationClient,  // Pass ShipStation client
                    shipmentId          // Pass shipment ID for label lookup
                );
                
                trackedOrder.rithumUpdated = true;
                trackedOrder.rithumUpdate.success = true;
                trackedOrder.rithumUpdate.updatedAt = new Date().toISOString();
                trackedOrder.rithumUpdate.trackingNumber = submittedTracking;
                trackedOrder.rithumUpdate.carrier = carrier;
                trackedOrder.rithumUpdate.lineItemCount = lineItemCount;
                trackedOrder.rithumUpdate.responses = {
                    status: statusResponse
                };

                trackedOrder.note = submittedTracking
                    ? `Label created - tracking: ${submittedTracking} - order status updated in Rithum`
                    : 'Label created - no tracking yet - order status updated in Rithum';

                const logTrackingNumber = submittedTracking || 'N/A';
                console.log(`   ✅ Updated Rithum order ${rithumOrderId}`);
                console.log(`      Status: shipped`);
                console.log(`      Tracking: ${logTrackingNumber}`);
                console.log(`      Line Items: ${lineItemCount}`);
            } catch (error) {
                trackedOrder.rithumUpdated = false;
                trackedOrder.rithumUpdate.error = {
                    message: error.message,
                    status: error.response?.status,
                    data: error.response?.data
                };
                trackedOrder.note = 'Label created - tracking captured locally - failed to update Rithum';

                console.error(`   ❌ Failed to update Rithum order ${rithumOrderId}:`, error.message);
                if (error.response) {
                    console.error('      Status:', error.response.status);
                    console.error('      Response:', JSON.stringify(error.response.data, null, 2));
                }
            }
        } else if (!rithumClient) {
            trackedOrder.rithumUpdate.attempted = false;
            trackedOrder.rithumUpdate.error = {
                message: 'Rithum client not configured'
            };
        } else {
            trackedOrder.rithumUpdate.error = {
                message: 'Rithum order ID not found on shipment'
            };
        }

        // Load existing tracked orders
        const trackingData = await loadTrackedOrders();

        // Check if this shipment was already tracked
        const existingIndex = trackingData.trackedOrders.findIndex(
            order => order.shipment.shipment_id === shipmentId
        );

        if (existingIndex >= 0) {
            // Update existing entry (label_created_v2 might come before fulfillment_shipped_v2)
            console.log(`   ⚠️  Shipment already tracked - updating entry`);
            // Only update if this is a more complete event (fulfillment_shipped_v2 takes precedence)
            const existing = trackingData.trackedOrders[existingIndex];
            if (existing.webhookEvent === 'fulfillment_shipped_v2') {
                console.log(`   ℹ️  Keeping fulfillment_shipped_v2 data (more complete)`);
                // Don't overwrite fulfillment_shipped_v2 with label_created_v2
            } else {
                trackingData.trackedOrders[existingIndex] = trackedOrder;
            }
        } else {
            // Add new entry
            trackingData.trackedOrders.push(trackedOrder);
            trackingData.totalTracked = trackingData.trackedOrders.length;
        }

        trackingData.lastUpdated = new Date().toISOString();

        // Save to file
        await saveTrackedOrders(trackingData);

        console.log(`   ✅ Label created order tracked successfully`);
        console.log(`   📊 Total tracked orders: ${trackingData.totalTracked}`);
        if (rithumOrderId) {
            console.log(`   🔗 Rithum Order ID: ${rithumOrderId}`);
            if (trackedOrder.rithumUpdated) {
                console.log('   📬 Rithum order updated successfully');
            } else if (trackedOrder.rithumUpdate.attempted) {
                console.log('   ⚠️  Failed to update Rithum order. See logs for details.');
            }
        } else {
            console.log(`   ⚠️  Rithum Order ID not found in shipment`);
        }

        return {
            success: true,
            trackedOrder,
            shipmentId,
            trackingNumber: trackedOrder.tracking.tracking_number
        };

    } catch (error) {
        console.error(`\n❌ Error processing label_created_v2 webhook:`, error.message);
        throw error;
    }
}

/**
 * Process fulfillment_shipped_v2 webhook event
 */
async function processFulfillmentShippedWebhook(webhookData, shipstationClient, rithumClient) {
    try {
        let fulfillment = webhookData.fulfillment || webhookData.data;

        if (!fulfillment) {
            fulfillment = extractFulfillmentFromLegacyPayload(webhookData);
        }
        if (!fulfillment) {
            throw new Error('No fulfillment data in webhook payload');
        }

        const shipmentId = fulfillment.shipment_id;
        if (!shipmentId) {
            throw new Error('No shipment_id in fulfillment data');
        }

        console.log(`\n📦 Processing shipped order webhook:`);
        console.log(`   Shipment ID: ${shipmentId}`);
        console.log(`   Tracking Number: ${fulfillment.tracking_number || 'N/A'}`);
        console.log(`   Carrier: ${fulfillment.carrier_name || fulfillment.carrier_id || 'N/A'}`);

        // Get full shipment details from ShipStation
        console.log(`   🔍 Fetching full shipment details...`);
        const shipment = await shipstationClient.getShipmentById(shipmentId);
        const trackingInfo = await shipstationClient.getShipmentTracking(shipmentId);

        // Fallback: use fulfillment data if shipment tracking is not populated yet
        if (!trackingInfo.tracking_number && fulfillment.tracking_number) {
            trackingInfo.tracking_number = fulfillment.tracking_number;
        }
        if (!trackingInfo.carrier_name && (fulfillment.carrier_name || fulfillment.carrier_id)) {
            trackingInfo.carrier_name = fulfillment.carrier_name || fulfillment.carrier_id;
        }
        if (!trackingInfo.ship_date && fulfillment.ship_date) {
            trackingInfo.ship_date = fulfillment.ship_date;
        }

        // Extract Rithum order ID
        const rithumOrderId = await extractRithumOrderId(shipment, shipstationClient);

        // Build tracked order information
        const trackedOrder = {
            timestamp: new Date().toISOString(),
            webhookEvent: 'fulfillment_shipped_v2',
            shipment: {
                shipment_id: shipment.shipment_id,
                shipment_number: shipment.shipment_number,
                external_shipment_id: shipment.external_shipment_id,
                shipment_status: shipment.shipment_status,
                sales_order_id: shipment.sales_order_id,
                created_at: shipment.created_at,
                modified_at: shipment.modified_at
            },
            tracking: {
                tracking_number: trackingInfo.tracking_number || fulfillment.tracking_number,
                carrier_id: trackingInfo.carrier_id || shipment.carrier_id,
                carrier_name: trackingInfo.carrier_name || shipment.carrier_name,
                ship_date: trackingInfo.ship_date || shipment.ship_date,
                estimated_delivery_date: trackingInfo.estimated_delivery_date || shipment.estimated_delivery_date,
                packages: trackingInfo.packages || shipment.packages || []
            },
            shipping: {
                ship_to: shipment.ship_to || null,
                ship_from: shipment.ship_from || null
            },
            rithumOrderId: rithumOrderId || null,
            rithumUpdated: false,
            rithumUpdate: {
                attempted: !!rithumClient && !!rithumOrderId,
                success: false,
                updatedAt: null,
                trackingNumber: null,
                carrier: null,
                error: null
            },
            note: rithumClient ? 'Tracking captured - awaiting Rithum update' : 'Tracking captured locally - Rithum client unavailable'
        };

        // Attempt to update Rithum with tracking information
        if (rithumClient && rithumOrderId) {
            try {
                const { statusResponse, trackingNumber: submittedTracking, carrier, lineItemCount } = await updateRithumOrderTracking(
                    rithumClient,
                    rithumOrderId,
                    shipment,
                    trackingInfo,
                    shipstationClient,  // Pass ShipStation client
                    shipmentId          // Pass shipment ID for label lookup
                );
                
                trackedOrder.rithumUpdated = true;
                trackedOrder.rithumUpdate.success = true;
                trackedOrder.rithumUpdate.updatedAt = new Date().toISOString();
                trackedOrder.rithumUpdate.trackingNumber = submittedTracking;
                trackedOrder.rithumUpdate.carrier = carrier;
                trackedOrder.rithumUpdate.lineItemCount = lineItemCount;
                trackedOrder.rithumUpdate.responses = {
                    status: statusResponse
                };

                trackedOrder.note = submittedTracking
                    ? `Fulfillment shipped - tracking: ${submittedTracking} - order status updated in Rithum`
                    : 'Fulfillment shipped - no tracking yet - order status updated in Rithum';

                const logTrackingNumber = submittedTracking || 'N/A';
                console.log(`   ✅ Updated Rithum order ${rithumOrderId}`);
                console.log(`      Status: shipped`);
                console.log(`      Tracking: ${logTrackingNumber}`);
                console.log(`      Line Items: ${lineItemCount}`);
            } catch (error) {
                trackedOrder.rithumUpdated = false;
                trackedOrder.rithumUpdate.error = {
                    message: error.message,
                    status: error.response?.status,
                    data: error.response?.data
                };
                trackedOrder.note = 'Tracking captured locally - failed to update Rithum';

                console.error(`   ❌ Failed to update Rithum order ${rithumOrderId}:`, error.message);
                if (error.response) {
                    console.error('      Status:', error.response.status);
                    console.error('      Response:', JSON.stringify(error.response.data, null, 2));
                }
            }
        } else if (!rithumClient) {
            trackedOrder.rithumUpdate.attempted = false;
            trackedOrder.rithumUpdate.error = {
                message: 'Rithum client not configured'
            };
        } else {
            trackedOrder.rithumUpdate.error = {
                message: 'Rithum order ID not found on shipment'
            };
        }

        // Load existing tracked orders
        const trackingData = await loadTrackedOrders();

        // Check if this shipment was already tracked
        const existingIndex = trackingData.trackedOrders.findIndex(
            order => order.shipment.shipment_id === shipmentId
        );

        if (existingIndex >= 0) {
            // Update existing entry
            console.log(`   ⚠️  Shipment already tracked - updating entry`);
            trackingData.trackedOrders[existingIndex] = trackedOrder;
        } else {
            // Add new entry
            trackingData.trackedOrders.push(trackedOrder);
            trackingData.totalTracked = trackingData.trackedOrders.length;
        }

        trackingData.lastUpdated = new Date().toISOString();

        // Save to file
        await saveTrackedOrders(trackingData);

        console.log(`   ✅ Shipped order tracked successfully`);
        console.log(`   📊 Total tracked orders: ${trackingData.totalTracked}`);
        if (rithumOrderId) {
            console.log(`   🔗 Rithum Order ID: ${rithumOrderId}`);
            if (trackedOrder.rithumUpdated) {
                console.log('   📬 Rithum order updated successfully');
            } else if (trackedOrder.rithumUpdate.attempted) {
                console.log('   ⚠️  Failed to update Rithum order. See logs for details.');
            }
        } else {
            console.log(`   ⚠️  Rithum Order ID not found in shipment`);
        }

        return {
            success: true,
            trackedOrder,
            shipmentId,
            trackingNumber: trackedOrder.tracking.tracking_number
        };

    } catch (error) {
        console.error(`\n❌ Error processing fulfillment_shipped_v2 webhook:`, error.message);
        throw error;
    }
}

/**
 * Process webhook event
 */
async function processWebhookEvent(webhookData, shipstationClient, rithumClient) {
    const eventTypeRaw = webhookData.event || webhookData.webhook_event || webhookData.type || webhookData.resource_type;
    const eventType = normalizeEventType(eventTypeRaw);

    if (!eventType) {
        throw new Error('Missing event type in webhook payload');
    }

    switch (eventType) {
        case 'fulfillment_shipped_v2':
        case 'fulfillment_shipped_v2 (legacy)':
        case 'fulfillment_shipped_v1':
        case 'fulfillment_shipped':
            return await processFulfillmentShippedWebhook(webhookData, shipstationClient, rithumClient);

        case 'label_created_v2':
            return await processLabelCreatedWebhook(webhookData, shipstationClient, rithumClient);

        case 'shipment_created_v2':
            return {
                success: true,
                message: 'Shipment created event received (not tracking - waiting for fulfillment_shipped_v2)',
                eventType
            };

        default:
            console.log(`   ℹ️  Unhandled event type: ${eventType}`);
            return {
                success: true,
                message: `Event type ${eventType} received but not specifically handled`,
                eventType
            };
    }
}

async function trackShippedOrder(webhookPayload) {
    try {
        let shipstationClient = null;
        try {
            validateShipStationConfig();
            shipstationClient = new ShipStationClient(
                shipstationConfig.apiKey,
                shipstationConfig.baseUrl,
                shipstationConfig.warehouseId,
                shipstationConfig.shipFrom
            );
            console.log('✅ ShipStation client initialized\n');
        } catch (error) {
            console.error('❌ Failed to initialize ShipStation client:', error.message);
            throw new Error('ShipStation client not configured');
        }
        let rithumClient = null;
        try {
            validateRithumConfig();
            rithumClient = new RithumClient(
                rithumConfig.apiUrl,
                rithumConfig.clientId,
                rithumConfig.clientSecret
            );
            console.log('✅ Rithum client initialized\n');
        } catch (error) {
            console.warn('⚠️  Rithum client not available:', error.message);
        }
        const result = await processWebhookEvent(webhookPayload, shipstationClient, rithumClient);

        return result;

    } catch (error) {
        console.error('\n❌ Error tracking shipped order:', error.message);
        throw error;
    }
}

/**
 * Get tracking summary
 */
async function getTrackingSummary() {
    try {
        const trackingData = await loadTrackedOrders();
        
        console.log('\n' + '='.repeat(80));
        console.log('📊 Shipped Orders Tracking Summary');
        console.log('='.repeat(80));
        console.log(`   Total Tracked Orders: ${trackingData.totalTracked}`);
        console.log(`   Last Updated: ${trackingData.lastUpdated || 'Never'}`);
        
        if (trackingData.trackedOrders.length > 0) {
            console.log(`\n   Recent Orders (last 5):`);
            const recent = trackingData.trackedOrders.slice(-5).reverse();
            recent.forEach((order, index) => {
                console.log(`\n   ${index + 1}. Shipment: ${order.shipment.shipment_number || order.shipment.shipment_id}`);
                console.log(`      Tracking: ${order.tracking.tracking_number || 'N/A'}`);
                console.log(`      Carrier: ${order.tracking.carrier_name || 'N/A'}`);
                console.log(`      Rithum Order ID: ${order.rithumOrderId || 'Not found'}`);
                console.log(`      Rithum Updated: ${order.rithumUpdated ? 'Yes' : 'No'}`);
                console.log(`      Tracked At: ${order.timestamp}`);
                if (order.rithumUpdate?.error) {
                    console.log(`      Rithum Error: ${order.rithumUpdate.error.message || 'Unknown error'}`);
                }
            });
        }
        
        console.log('\n' + '='.repeat(80) + '\n');
        
        return trackingData;
    } catch (error) {
        console.error('Error getting tracking summary:', error.message);
        throw error;
    }
}

/**
 * Start Express server to receive webhooks
 * Perfect for use with ngrok!
 */
function startWebhookServer() {
    const app = express();
    app.use(express.json());

    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            service: 'Webhook Step 2 - Shipped Orders Tracker',
            timestamp: new Date().toISOString()
        });
    });
    
    const webhookHandler = async (req, res) => {
        try {
            console.log('📨 Received webhook request');
            // Process the webhook
            const result = await trackShippedOrder(req.body);

            res.status(200).json({
                success: true,
                message: 'Webhook processed successfully',
                ...result
            });
        } catch (error) {
            console.error('Error processing webhook:', error.message);
            res.status(200).json({
                success: false,
                message: 'Error processing webhook',
                error: error.message
            });
        }
    };

    // Webhook endpoints - accepts base path and API-style path
    app.post('/webhook', webhookHandler);
    app.post('/api/shipstation/webhooks/v2', webhookHandler);
    
    // Summary endpoint
    app.get('/summary', async (req, res) => {
        try {
            const summary = await getTrackingSummary();
            res.json({
                success: true,
                ...summary
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });
    
    // Start server
    app.listen(PORT, () => {
        console.log('\n' + '='.repeat(80));
        console.log('🚀 Webhook Step 2 Server Started');
        console.log('='.repeat(80));
        console.log(`   Local URL: http://localhost:${PORT}`);
        console.log(`   Webhook Endpoint: http://localhost:${PORT}/webhook`);
        console.log(`   Health Check: http://localhost:${PORT}/health`);
        console.log(`   Summary: http://localhost:${PORT}/summary`);
        console.log('\n📡 To use with ngrok:');
        console.log(`   1. Run: ngrok http ${PORT}`);
        console.log(`   2. Copy the ngrok URL (e.g., https://abc123.ngrok.io)`);
        console.log(`   3. Configure ShipStation webhook to: https://abc123.ngrok.io/webhook`);
        console.log(`   4. Event type: fulfillment_shipped_v2`);
        console.log('\n' + '='.repeat(80) + '\n');
    });
}

// Export functions for use as module
module.exports = {
    trackShippedOrder,
    processWebhookEvent,
    getTrackingSummary,
    loadTrackedOrders
};

// Run if called directly
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args[0] === '--server' || args[0] === '--serve') {
        // Start webhook server (for use with ngrok)
        startWebhookServer();
    } else if (args.length === 0) {
        // No arguments - show summary
        getTrackingSummary().catch(error => {
            console.error('Error:', error.message);
            process.exit(1);
        });
    } else if (args[0] === '--summary' || args[0] === '-s') {
        // Show summary
        getTrackingSummary().catch(error => {
            console.error('Error:', error.message);
            process.exit(1);
        });
    } else {
        // Process webhook payload from command line (JSON string)
        try {
            const webhookPayload = JSON.parse(args[0]);
            trackShippedOrder(webhookPayload)
                .then(result => {
                    console.log('\n✅ Webhook processed successfully');
                    process.exit(0);
                })
                .catch(error => {
                    console.error('\n❌ Failed to process webhook:', error.message);
                    process.exit(1);
                });
        } catch (error) {
            console.error('❌ Invalid JSON payload:', error.message);
                        process.exit(1);
        }
    }
}
