#!/usr/bin/env node

/**
 * Test script to send a single order from Rithum to ShipStation
 * This is useful for testing the integration with just one order
 */

require('dotenv').config();
const OrderMapper = require('./src/services/orderMapper');
const ShipStationClient = require('./src/services/shipstationClient');
const RithumClient = require('./src/services/rithumClient');
const { shipstationConfig, validateConfig: validateShipStationConfig } = require('./src/config/shipstationConfig');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

async function testSingleOrder() {
    try {
        console.log('🧪 Test: Send Single Order from Rithum to ShipStation\n');
        console.log('='.repeat(80) + '\n');

        // Initialize Rithum client
        console.log('📥 Initializing Rithum client...');
        validateRithumConfig();
        const rithumClient = new RithumClient(
            rithumConfig.apiUrl,
            rithumConfig.clientId,
            rithumConfig.clientSecret
        );
        console.log('✅ Rithum client initialized\n');

        // Initialize ShipStation client
        console.log('📦 Initializing ShipStation client...');
        validateShipStationConfig();
        
        // Use test ship_from address if no warehouse or ship_from is configured
        let shipFrom = shipstationConfig.shipFrom;
        if (!shipstationConfig.warehouseId && !shipFrom) {
            console.log('⚠️  No warehouse_id or ship_from configured, using test JaxKelly Inc address...');
            shipFrom = {
                name: 'JaxKelly Inc',
                company_name: 'JaxKelly Inc',
                address_line1: '2555 State Street',
                address_line2: 'Unit 102',
                city_locality: 'San Diego',
                state_province: 'CA',
                postal_code: '92101',
                country_code: 'US',
                phone: '6199558475'
            };
        }
        
        const shipstationClient = new ShipStationClient(
            shipstationConfig.apiKey,
            shipstationConfig.baseUrl,
            shipstationConfig.warehouseId,
            shipFrom
        );
        console.log('✅ ShipStation client initialized');
        if (shipFrom && !shipstationConfig.shipFrom) {
            console.log('   Using test ship_from address for this test\n');
        } else {
            console.log('');
        }

        // Step 1: Fetch new orders from Rithum
        console.log('📥 Step 1: Fetching new orders from Rithum...\n');
        const rithumResponse = await rithumClient.checkForNewOrders(true); // includeOrderDetails = true

        if (!rithumResponse.success) {
            console.error('❌ Failed to fetch orders from Rithum:', rithumResponse.error || 'Unknown error');
            process.exit(1);
        }

        const orders = rithumResponse.orderDetails || [];
        const newOrderCount = rithumResponse.newOrderCount || 0;

        console.log(`✅ Found ${newOrderCount} new order(s) from Rithum\n`);

        if (!orders || orders.length === 0) {
            console.log('ℹ️  No orders found to process.');
            console.log('   Make sure there are new orders in Rithum.\n');
            process.exit(0);
        }

        // Take only the first order for testing
        const testOrder = orders[0];
        const orderId = testOrder.id || testOrder.dscoOrderId || 'unknown';

        console.log('📋 Selected first order for testing:');
        console.log(`   Order ID: ${orderId}`);
        console.log(`   PO Number: ${testOrder.poNumber || 'N/A'}`);
        console.log(`   Status: ${testOrder.dscoStatus || 'N/A'}`);
        console.log(`   Items: ${testOrder.lineItems?.length || 0}\n`);

        // Step 2: Map order to ShipStation format
        console.log('🔄 Step 2: Mapping order to ShipStation format...\n');
        const mapper = new OrderMapper();

        // Check if should process
        if (!mapper.shouldProcess(testOrder)) {
            console.log(`⏭️  Order skipped - status: ${testOrder.dscoStatus || 'unknown'}`);
            console.log('   This order does not meet the processing criteria.\n');
            process.exit(0);
        }

        // Validate and map
        const mappingResult = mapper.mapAndValidate(testOrder);

        if (!mappingResult.success) {
            console.error('❌ Failed to map order:');
            mappingResult.errors.forEach(err => console.error(`   - ${err}`));
            if (mappingResult.validation?.errors) {
                mappingResult.validation.errors.forEach(err => console.error(`   - Validation: ${err}`));
            }
            process.exit(1);
        }

        console.log('✅ Order mapped successfully');
        console.log(`   ShipStation Order Number: ${mappingResult.mappedOrder.orderNumber}`);
        console.log(`   Status: ${mappingResult.mappedOrder.orderStatus}`);
        console.log(`   Items: ${mappingResult.mappedOrder.items.length}`);
        console.log(`   Ship To: ${mappingResult.mappedOrder.shipTo.name}, ${mappingResult.mappedOrder.shipTo.city_locality}, ${mappingResult.mappedOrder.shipTo.state_province}\n`);

        // Step 3: Create order in ShipStation
        console.log('🚀 Step 3: Creating order in ShipStation...\n');
        console.log('   Endpoint: POST /v2/shipments');
        console.log('   Method: createOrder() with create_sales_order: true\n');

        const createdOrder = await shipstationClient.createOrder(mappingResult.mappedOrder);

        // Get ship_from address
        let shipFromAddress = null;
        let warehouseId = null;

        // Check creation response
        if (createdOrder.ship_from) {
            shipFromAddress = createdOrder.ship_from;
            console.log('   📍 Ship From address from creation response');
        } else if (createdOrder.warehouse_id) {
            warehouseId = createdOrder.warehouse_id;
            console.log(`   📦 Warehouse ID from creation response: ${warehouseId}`);
        }

        // Fallback to sent data
        if (!shipFromAddress && !warehouseId && createdOrder.sent_ship_from) {
            shipFromAddress = createdOrder.sent_ship_from;
            console.log('   📍 Ship From address from sent data');
        }

        // Fetch full details if needed
        if (!shipFromAddress && !warehouseId && createdOrder.shipment_id) {
            try {
                console.log('   🔍 Fetching full shipment details...');
                const shipmentResponse = await shipstationClient.client.get(`/v2/shipments/${createdOrder.shipment_id}`);
                const shipment = shipmentResponse.data;
                if (shipment.ship_from) {
                    shipFromAddress = shipment.ship_from;
                }
                if (shipment.warehouse_id) {
                    warehouseId = shipment.warehouse_id;
                }
            } catch (detailError) {
                console.log(`   ⚠️  Could not retrieve shipment details: ${detailError.message}`);
            }
        }

        // Final fallback
        if (!shipFromAddress && createdOrder.sent_ship_from) {
            shipFromAddress = createdOrder.sent_ship_from;
        }

        // Display results
        console.log('\n' + '='.repeat(80));
        console.log('\n✅ Order Successfully Created in ShipStation!\n');
        console.log('📊 Order Details:');
        console.log(`   Rithum Order ID: ${orderId}`);
        console.log(`   PO Number: ${testOrder.poNumber || 'N/A'}`);
        console.log(`   ShipStation Order Number: ${createdOrder.order_number || 'N/A'}`);
        console.log(`   Sales Order ID: ${createdOrder.sales_order_id || createdOrder.order_id || createdOrder.shipment_id || 'N/A'}`);
        console.log(`   Shipment ID: ${createdOrder.shipment_id || 'N/A'}\n`);

        if (shipFromAddress) {
            console.log('📍 Ship From Address:');
            console.log(`   Company: ${shipFromAddress.company_name || shipFromAddress.name || 'N/A'}`);
            console.log(`   Address: ${shipFromAddress.address_line1 || ''}${shipFromAddress.address_line2 ? ', ' + shipFromAddress.address_line2 : ''}`);
            console.log(`   City: ${shipFromAddress.city_locality || 'N/A'}`);
            console.log(`   State: ${shipFromAddress.state_province || 'N/A'}`);
            console.log(`   Postal: ${shipFromAddress.postal_code || 'N/A'}`);
            console.log(`   Country: ${shipFromAddress.country_code || 'N/A'}`);
            console.log(`   Phone: ${shipFromAddress.phone || 'N/A'}\n`);
        } else if (warehouseId) {
            console.log(`📦 Warehouse ID: ${warehouseId}\n`);
        }

        console.log('💡 You can verify this order in your ShipStation dashboard.\n');
        console.log('='.repeat(80) + '\n');

    } catch (error) {
        console.error('\n❌ Test Failed!\n');
        console.error('Error:', error.message);
        
        if (error.response) {
            console.error('\n📡 API Response Details:');
            console.error(`   Status: ${error.response.status} ${error.response.statusText}`);
            console.error(`   Response Data:`, JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
            console.error('\n⚠️  No response received from API');
            console.error('   Check your internet connection and API credentials');
        }
        
        console.error('\n📋 Error Stack:');
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the test
testSingleOrder();

