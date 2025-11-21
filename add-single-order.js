require('dotenv').config({ override: true });
const RithumClient = require('./src/services/rithumClient');
const ShipStationClient = require('./src/services/shipstationClient');
const OrderMapper = require('./src/services/orderMapper');
const { rithumConfig } = require('./src/config/rithumConfig');
const { shipstationConfig } = require('./src/config/shipstationConfig');

/**
 * Script to add a single order from Rithum to ShipStation
 * Usage: node add-single-order.js BOX.75797302.69964112
 */

const poNumber = process.argv[2];

if (!poNumber) {
    console.error('❌ Please provide a PO Number (e.g., BOX.75797302.69964112)');
    console.error('Usage: node add-single-order.js <PO_NUMBER>');
    process.exit(1);
}

console.log('🚀 Adding Single Order from Rithum to ShipStation');
console.log('═'.repeat(60));
console.log(`📋 PO Number: ${poNumber}`);
console.log('');

async function addSingleOrder() {
    try {
        // Initialize clients
        console.log('🔧 Initializing clients...');
        
        const rithumClient = new RithumClient(
            rithumConfig.apiUrl,
            rithumConfig.clientId,
            rithumConfig.clientSecret
        );
        
        const shipstationClient = new ShipStationClient(
            shipstationConfig.apiKey,
            shipstationConfig.baseUrl,
            shipstationConfig.warehouseId,
            shipstationConfig.shipFrom
        );
        
        const orderMapper = new OrderMapper();
        console.log('✅ Clients initialized');
        
        // Step 1: Find the order in Rithum by PO Number
        console.log(`\n🔍 Searching for order with PO Number: ${poNumber}`);
        
        // Use a time range to search for the order
        const until = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago (required by API)
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days ago
        
        console.log(`   Time range: ${since} to ${until}`);
        
        let rithumOrder = null;
        let scrollId = null;
        let searchAttempts = 0;
        const maxAttempts = 5; // Limit search to prevent infinite loops
        
        do {
            searchAttempts++;
            console.log(`   📄 Searching page ${searchAttempts}...`);
            
            const params = {
                ordersUpdatedSince: since,
                until: until,
                ordersPerPage: 100
            };
            
            if (scrollId) {
                params.scrollId = scrollId;
            }
            
            const response = await rithumClient.fetchOrders(params);
            
            if (response.orders && response.orders.length > 0) {
                console.log(`   Found ${response.orders.length} orders in this page`);
                
                // Search for our PO number
                for (const order of response.orders) {
                    if (order.poNumber === poNumber) {
                        console.log(`   ✅ Found order! Order ID: ${order.dscoOrderId}`);
                        rithumOrder = order;
                        break;
                    }
                }
                
                if (rithumOrder) {
                    break; // Found it!
                }
                
                scrollId = response.scrollId;
            } else {
                console.log('   No orders found in this page');
                break;
            }
            
        } while (scrollId && searchAttempts < maxAttempts && !rithumOrder);
        
        if (!rithumOrder) {
            console.error(`❌ Order with PO Number ${poNumber} not found in Rithum`);
            console.error(`   Searched ${searchAttempts} pages within the last 90 days`);
            console.error(`   Please verify the PO Number is correct and the order exists`);
            process.exit(1);
        }
        
        // Step 2: Get full order details if needed
        console.log(`\n📋 Getting full order details...`);
        let fullOrder = rithumOrder;
        
        // Check if we need to fetch more details
        if (!rithumOrder.lineItems || rithumOrder.lineItems.length === 0) {
            console.log(`   Fetching complete order details for ${rithumOrder.dscoOrderId}...`);
            try {
                fullOrder = await rithumClient.getOrderById(rithumOrder.dscoOrderId, {
                    include: ['lineItems', 'shipping', 'shipTo', 'billTo']
                });
                console.log(`   ✅ Retrieved full order details`);
            } catch (error) {
                console.warn(`   ⚠️  Could not fetch full details: ${error.message}`);
                console.log(`   Continuing with available data...`);
                fullOrder = rithumOrder;
            }
        }
        
        console.log(`   Order ID: ${fullOrder.dscoOrderId}`);
        console.log(`   Lifecycle: ${fullOrder.dscoLifecycle}`);
        console.log(`   Line Items: ${fullOrder.lineItems?.length || 0}`);
        
        if (!fullOrder.lineItems || fullOrder.lineItems.length === 0) {
            console.error(`❌ Order has no line items - cannot create shipment`);
            process.exit(1);
        }
        
        // Step 3: Map to ShipStation format
        console.log(`\n🔄 Mapping to ShipStation format...`);
        const shipstationOrder = orderMapper.mapToShipStation(fullOrder);
        
        console.log(`   ✅ Weight: ${shipstationOrder.weight?.value || 'N/A'} ${shipstationOrder.weight?.unit || ''}`);
        console.log(`   📦 Package: ${shipstationOrder.packageCode || 'N/A'}`);
        console.log(`   🚚 Service: ${shipstationOrder.serviceCode || 'N/A'}`);
        console.log(`   💰 Amount Paid: ${shipstationOrder.amountPaid || 'N/A'}`);
        
        // Step 4: Get warehouse info if needed
        console.log(`\n📦 Checking warehouse configuration...`);
        let warehouseId = shipstationConfig.warehouseId;
        let shipFromAddress = shipstationConfig.shipFrom;
        
        if (!shipFromAddress && !warehouseId) {
            console.log('   Getting warehouse address from ShipStation...');
            try {
                const warehouses = await shipstationClient.getWarehouses();
                if (warehouses && warehouses.length > 0) {
                    const warehouse = warehouses.find(w => w.is_default) || warehouses[0];
                    warehouseId = warehouse.warehouse_id;
                    console.log(`   ✅ Using warehouse: ${warehouse.name || warehouseId}`);
                }
            } catch (error) {
                console.warn(`   ⚠️  Could not get warehouse info: ${error.message}`);
            }
        }
        
        // Add warehouse info to the order
        if (shipFromAddress) {
            shipstationOrder.shipFrom = shipFromAddress;
            console.log(`   ✅ Using configured ship_from address`);
        } else if (warehouseId) {
            shipstationOrder.warehouse_id = warehouseId;
            console.log(`   ✅ Using warehouse ID: ${warehouseId}`);
        } else {
            console.warn(`   ⚠️  No ship_from address or warehouse_id available - order may fail`);
        }
        
        // Step 5: Create order in ShipStation
        console.log(`\n📤 Creating order in ShipStation...`);
        console.log(`   Order Number: ${shipstationOrder.orderNumber}`);
        console.log(`   External ID: ${shipstationOrder.orderNumber}`);
        
        // Add carrier_id for USPS if service code is USPS-based
        if (shipstationOrder.serviceCode && shipstationOrder.serviceCode.includes('usps')) {
            // Use the primary USPS carrier ID
            shipstationOrder.carrierId = 'se-287927';
            console.log(`   🚚 Using USPS carrier: ${shipstationOrder.carrierId}`);
        }
        
        try {
            const response = await shipstationClient.createOrder(shipstationOrder);
            
            console.log(`\n🎉 SUCCESS! Order created in ShipStation`);
            console.log(`   ShipStation Order ID: ${response.order_id || response.sales_order_id || 'Created'}`);
            console.log(`   Shipment ID: ${response.shipment_id || 'N/A'}`);
            console.log(`   Order Number: ${response.order_number || shipstationOrder.orderNumber}`);
            
            if (response.ship_from) {
                console.log(`   Ship From: ${response.ship_from.name || 'N/A'}, ${response.ship_from.city_locality || 'N/A'}`);
            } else if (response.warehouse_id) {
                console.log(`   Warehouse ID: ${response.warehouse_id}`);
            }
            
            console.log(`\n✅ Order ${poNumber} successfully added to ShipStation!`);
            
            return {
                success: true,
                poNumber: poNumber,
                rithumOrderId: fullOrder.dscoOrderId,
                shipstationResponse: response
            };
            
        } catch (error) {
            console.error(`\n❌ FAILED to create order in ShipStation:`);
            console.error(`   Error: ${error.message}`);
            
            if (error.response?.data) {
                console.error(`   Response:`, JSON.stringify(error.response.data, null, 2));
            }
            
            return {
                success: false,
                poNumber: poNumber,
                rithumOrderId: fullOrder.dscoOrderId,
                error: error.message
            };
        }
        
    } catch (error) {
        console.error(`\n💥 Unexpected error:`, error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the script
addSingleOrder()
    .then((result) => {
        if (result.success) {
            console.log(`\n🎯 Summary:`);
            console.log(`   PO Number: ${result.poNumber}`);
            console.log(`   Rithum Order ID: ${result.rithumOrderId}`);
            console.log(`   Status: ✅ Successfully added to ShipStation`);
        } else {
            console.log(`\n🎯 Summary:`);
            console.log(`   PO Number: ${result.poNumber}`);
            console.log(`   Rithum Order ID: ${result.rithumOrderId}`);
            console.log(`   Status: ❌ Failed - ${result.error}`);
            process.exit(1);
        }
    })
    .catch((error) => {
        console.error('Script failed:', error.message);
        process.exit(1);
    });