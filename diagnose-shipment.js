require('dotenv').config();
const ShipStationClient = require('./src/services/shipstationClient');
const RithumClient = require('./src/services/rithumClient');
const { shipstationConfig, validateConfig: validateShipStationConfig } = require('./src/config/shipstationConfig');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

/**
 * Diagnose why a shipment update might be failing
 * Fetches the shipment from ShipStation and analyzes what would be sent to Rithum
 */

async function diagnoseShipment(shipmentId) {
    console.log(`\n🔍 Diagnosing Shipment: ${shipmentId}`);
    console.log('='.repeat(80));
    
    try {
        validateShipStationConfig();
        validateRithumConfig();
        
        const shipstationClient = new ShipStationClient(
            shipstationConfig.apiKey,
            shipstationConfig.apiSecret,
            shipstationConfig.apiUrl
        );
        
        const rithumClient = new RithumClient(
            rithumConfig.apiUrl,
            rithumConfig.clientId,
            rithumConfig.clientSecret
        );
        
        // Fetch shipment from ShipStation
        console.log(`\n📦 Fetching shipment from ShipStation...`);
        const shipment = await shipstationClient.getShipmentById(shipmentId);
        
        console.log(`\n✅ Shipment retrieved`);
        console.log(`   Shipment Number: ${shipment.shipment_number}`);
        console.log(`   Order ID: ${shipment.external_shipment_id}`);
        console.log(`   Status: ${shipment.shipment_status}`);
        console.log(`   Created: ${shipment.created_at}`);
        
        // Extract order ID
        const rithumOrderId = shipment.external_shipment_id;
        if (!rithumOrderId) {
            console.log(`\n❌ ERROR: No external_shipment_id (Rithum Order ID) found in shipment`);
            return;
        }
        
        // Check order in Rithum
        console.log(`\n🔍 Checking order in Rithum: ${rithumOrderId}...`);
        const until = new Date().toISOString();
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        
        const ordersResponse = await rithumClient.fetchOrders({
            ordersUpdatedSince: since,
            until: until,
            ordersPerPage: 100
        });
        
        const rithumOrder = ordersResponse.orders.find(o => o.dscoOrderId === rithumOrderId);
        
        if (!rithumOrder) {
            console.log(`\n❌ ERROR: Order ${rithumOrderId} not found in Rithum`);
            console.log(`   The order may be too old or doesn't exist`);
            return;
        }
        
        console.log(`\n✅ Found order in Rithum`);
        console.log(`   PO Number: ${rithumOrder.poNumber}`);
        console.log(`   Lifecycle: ${rithumOrder.dscoLifecycle}`);
        console.log(`   Requested Shipping: ${rithumOrder.requestedShippingServiceLevelCode || 'N/A'}`);
        console.log(`   Current Packages: ${rithumOrder.packages?.length || 0}`);
        
        // Check lifecycle
        if (rithumOrder.dscoLifecycle !== 'acknowledged' && rithumOrder.dscoLifecycle !== 'completed') {
            console.log(`\n❌ PROBLEM: Order lifecycle is "${rithumOrder.dscoLifecycle}"`);
            console.log(`   Shipments can only be added to orders with lifecycle "acknowledged" or "completed"`);
            console.log(`   This is likely why the update failed!`);
            return { issue: 'invalid_lifecycle', lifecycle: rithumOrder.dscoLifecycle };
        }
        
        // Analyze the shipment data
        console.log(`\n📋 Analyzing shipment data...`);
        
        // Extract tracking
        const trackingNumber = shipment.tracking_number || shipment.packages?.[0]?.tracking_number;
        console.log(`   Tracking Number: ${trackingNumber || 'MISSING'}`);
        if (!trackingNumber) {
            console.log(`   ❌ PROBLEM: No tracking number found!`);
        }
        
        // Extract carrier
        const carrierName = shipment.carrier?.name || shipment.carrier_name;
        const carrierCode = shipment.carrier?.carrier_code || shipment.carrier_code;
        console.log(`   Carrier: ${carrierName || carrierCode || 'MISSING'}`);
        
        // Extract line items
        const items = shipment.items || [];
        console.log(`\n   📦 Line Items: ${items.length}`);
        
        if (items.length === 0) {
            console.log(`   ❌ PROBLEM: No line items in shipment!`);
            console.log(`      Rithum requires at least one line item with quantity and identifier`);
            return { issue: 'no_line_items' };
        }
        
        items.forEach((item, i) => {
            console.log(`\n   Item ${i + 1}:`);
            console.log(`      SKU: ${item.sku || 'MISSING'}`);
            console.log(`      Quantity: ${item.quantity || item.ordered_quantity || 'MISSING'}`);
            console.log(`      dscoItemId: ${item.external_order_item_id || item.sales_order_item_id || 'MISSING'}`);
            console.log(`      Partner SKU: ${item.partner_sku || 'N/A'}`);
            console.log(`      UPC: ${item.upc || 'N/A'}`);
            
            // Check if item has valid identifier
            const hasIdentifier = item.external_order_item_id || item.sales_order_item_id || 
                                item.sku || item.partner_sku || item.upc;
            if (!hasIdentifier) {
                console.log(`      ❌ PROBLEM: No valid identifier for this item!`);
            }
            
            // Check quantity
            const qty = item.quantity || item.ordered_quantity;
            if (!qty || qty <= 0) {
                console.log(`      ❌ PROBLEM: Invalid quantity: ${qty}`);
            }
        });
        
        // Build the shipment payload that would be sent
        console.log(`\n📤 Building Rithum shipment payload...`);
        
        const lineItems = items.map(item => {
            const rawQuantity = item.quantity || item.ordered_quantity || 1;
            const quantity = Number(rawQuantity);
            
            if (!quantity || Number.isNaN(quantity) || quantity <= 0) {
                return null;
            }
            
            const lineItem = { quantity };
            
            const dscoItemId = item.external_order_item_id || item.sales_order_item_id || 
                             item.dsco_item_id || item.dscoItemId;
            if (dscoItemId != null && dscoItemId !== '') {
                lineItem.dscoItemId = String(dscoItemId);
            }
            
            if (!lineItem.dscoItemId) {
                if (item.sku) {
                    lineItem.sku = String(item.sku);
                } else if (item.partner_sku || item.partnerSku) {
                    lineItem.partnerSku = String(item.partner_sku || item.partnerSku);
                } else if (item.upc) {
                    lineItem.upc = String(item.upc);
                }
            }
            
            if (!lineItem.dscoItemId && !lineItem.sku && !lineItem.partnerSku && !lineItem.upc) {
                return null;
            }
            
            return lineItem;
        }).filter(Boolean);
        
        if (lineItems.length === 0) {
            console.log(`\n❌ PROBLEM: No valid line items after filtering!`);
            console.log(`   All items must have at least one identifier (dscoItemId, sku, partnerSku, or upc)`);
            return { issue: 'no_valid_line_items' };
        }
        
        // Build full payload
        const shipmentData = {
            dscoOrderId: rithumOrderId,
            shipments: [
                {
                    trackingNumber: trackingNumber || 'NO_TRACKING',
                    shipDate: shipment.ship_date || new Date().toISOString(),
                    shipWeight: shipment.total_weight?.value || shipment.packages?.[0]?.weight?.value || 1,
                    shipWeightUnits: shipment.total_weight?.unit || shipment.packages?.[0]?.weight?.unit || 'oz',
                    shipCost: shipment.shipping_amount?.amount || 0,
                    carrierManifestId: carrierName?.toUpperCase() || 'USPS',
                    shippingServiceLevelCode: rithumOrder.requestedShippingServiceLevelCode || 'UPCG',
                    shipMethod: 'Ground',
                    lineItems: lineItems
                }
            ]
        };
        
        console.log(`\n📋 Rithum Payload:`);
        console.log(JSON.stringify(shipmentData, null, 2));
        
        console.log(`\n✅ Diagnosis complete`);
        console.log(`\n📊 Summary:`);
        console.log(`   ✅ Order exists in Rithum`);
        console.log(`   ${rithumOrder.dscoLifecycle === 'acknowledged' ? '✅' : '❌'} Lifecycle is valid: ${rithumOrder.dscoLifecycle}`);
        console.log(`   ${trackingNumber ? '✅' : '❌'} Tracking number: ${trackingNumber || 'MISSING'}`);
        console.log(`   ${lineItems.length > 0 ? '✅' : '❌'} Valid line items: ${lineItems.length}`);
        
        return { shipmentData, rithumOrder, shipment };
        
    } catch (error) {
        console.error(`\n❌ Diagnosis failed:`, error.message);
        if (error.response?.data) {
            console.error(`   API Error:`, JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

// Run if called directly
if (require.main === module) {
    const shipmentId = process.argv[2];
    
    if (!shipmentId) {
        console.error('❌ Error: Please provide a shipment ID');
        console.log('\nUsage: node diagnose-shipment.js <shipment_id>');
        console.log('Example: node diagnose-shipment.js se-920983006');
        process.exit(1);
    }
    
    diagnoseShipment(shipmentId)
        .then(() => {
            console.log('\n✅ Done');
            process.exit(0);
        })
        .catch((error) => {
            console.error('\n❌ Failed:', error.message);
            process.exit(1);
        });
}

module.exports = { diagnoseShipment };
