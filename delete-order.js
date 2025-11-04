#!/usr/bin/env node

/**
 * Script to delete/cancel an order in ShipStation
 * 
 * Usage:
 *   node delete-order.js <shipment_id>           - Delete by shipment ID
 *   node delete-order.js --order-id <order_id>   - Delete by order ID (sales_order_id)
 *   node delete-order.js --order-number <number>  - Delete by order number (PO number)
 */

require('dotenv').config();
const ShipStationClient = require('./src/services/shipstationClient');
const { shipstationConfig, validateConfig } = require('./src/config/shipstationConfig');

async function deleteOrder() {
    try {
        const args = process.argv.slice(2);
        
        if (args.length === 0) {
            console.log('❌ Usage:');
            console.log('   node delete-order.js <shipment_id>');
            console.log('   node delete-order.js --order-id <order_id>');
            console.log('   node delete-order.js --order-number <order_number>');
            console.log('\nExample:');
            console.log('   node delete-order.js se-917262919');
            console.log('   node delete-order.js --order-number BOX.75478007.69859383');
            process.exit(1);
        }

        // Validate configuration
        validateConfig();
        
        const client = new ShipStationClient(
            shipstationConfig.apiKey,
            shipstationConfig.baseUrl,
            shipstationConfig.warehouseId,
            shipstationConfig.shipFrom
        );

        let result;

        if (args[0] === '--order-id' && args[1]) {
            // Delete by order ID
            console.log(`🗑️  Deleting order by Order ID: ${args[1]}\n`);
            result = await client.deleteOrderByOrderId(args[1]);
        } else if (args[0] === '--order-number' && args[1]) {
            // Delete by order number
            console.log(`🗑️  Deleting order by Order Number: ${args[1]}\n`);
            result = await client.deleteOrderByOrderNumber(args[1]);
        } else {
            // Assume it's a shipment ID
            console.log(`🗑️  Deleting order by Shipment ID: ${args[0]}\n`);
            result = await client.deleteOrderByShipmentId(args[0]);
        }

        console.log('\n' + '='.repeat(80));
        console.log('\n✅ Order Deleted Successfully!\n');
        console.log('📊 Result:');
        console.log(JSON.stringify(result, null, 2));
        console.log('\n💡 The order has been cancelled in ShipStation.\n');
        console.log('='.repeat(80) + '\n');

    } catch (error) {
        console.error('\n❌ Failed to delete order!\n');
        console.error('Error:', error.message);
        
        if (error.response) {
            console.error('\n📡 API Response Details:');
            console.error(`   Status: ${error.response.status} ${error.response.statusText}`);
            console.error(`   Response Data:`, JSON.stringify(error.response.data, null, 2));
        }
        
        process.exit(1);
    }
}

deleteOrder();

