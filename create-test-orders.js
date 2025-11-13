require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const OrderMapper = require('./src/services/orderMapper');
const ShipStationClient = require('./src/services/shipstationClient');

console.log('🧪 Creating Test Orders in ShipStation from Real Rithum Data\n');
console.log('═'.repeat(80));

// Order files to process - testing with one order first
const orderFiles = [
    'order_1026064154.json'  // 3 items, created order
    // 'order_1022178919.json',
    // 'order_1022844358.json',
    // 'order_1025416768.json',
    // 'order_1026063942.json',
    // 'order_1026064160.json',
    // 'order_1026064165.json'
];

/**
 * Load and parse Rithum order from JSON file
 */
function loadRithumOrder(filename) {
    try {
        const content = fs.readFileSync(filename, 'utf8');
        const jsonStart = content.indexOf('\n{');
        if (jsonStart === -1) {
            throw new Error('No JSON found in file');
        }
        const jsonStr = content.substring(jsonStart).trim();
        return JSON.parse(jsonStr);
    } catch (error) {
        console.error(`❌ Error loading ${filename}:`, error.message);
        return null;
    }
}

/**
 * Modify order for testing (add TEST prefix, change IDs)
 */
function makeTestOrder(rithumOrder, index) {
    const testOrder = JSON.parse(JSON.stringify(rithumOrder)); // Deep clone
    
    // Add TEST prefix to PO number
    testOrder.poNumber = `TEST-${testOrder.poNumber}`;
    
    // Create unique test order ID with timestamp to avoid duplicates
    const timestamp = Date.now().toString().slice(-6); // Last 6 digits of timestamp
    const originalId = testOrder.dscoOrderId;
    testOrder.dscoOrderId = `9${originalId}-${timestamp}`; // Prefix with 9 and add timestamp
    
    // Mark as test
    testOrder.testFlag = true;
    
    // Update line items with test prefix
    if (testOrder.lineItems) {
        testOrder.lineItems.forEach(item => {
            item.dscoItemId = `9${item.dscoItemId}`;
        });
    }
    
    return testOrder;
}

/**
 * Main function to create test orders
 */
async function createTestOrders() {
    const mapper = new OrderMapper();
    const { shipstationConfig } = require('./src/config/shipstationConfig');
    const shipstationClient = new ShipStationClient(
        shipstationConfig.apiKey,
        shipstationConfig.baseUrl,
        shipstationConfig.warehouseId,
        shipstationConfig.shipFrom
    );
    
    // Fetch warehouse address if not configured
    let shipFromAddress = null;
    let warehouseId = null;
    
    if (!shipstationConfig.shipFrom && !shipstationConfig.warehouseId) {
        console.log('📦 Fetching warehouse address from ShipStation...\n');
        try {
            const warehouses = await shipstationClient.getWarehouses();
            if (warehouses && warehouses.length > 0) {
                const warehouse = warehouses.find(w => w.is_default) || warehouses[0];
                warehouseId = warehouse.warehouse_id;
                console.log(`✅ Using warehouse: ${warehouse.name || warehouseId}\n`);
            }
        } catch (error) {
            console.warn(`⚠️  Could not fetch warehouses: ${error.message}`);
        }
    }
    
    const results = {
        success: [],
        failed: []
    };
    
    console.log(`📦 Processing ${orderFiles.length} orders...\n`);
    
    for (let i = 0; i < orderFiles.length; i++) {
        const filename = orderFiles[i];
        const orderNum = i + 1;
        
        console.log(`\n${'─'.repeat(80)}`);
        console.log(`\n[${orderNum}/${orderFiles.length}] Processing: ${filename}`);
        
        // Load Rithum order
        const rithumOrder = loadRithumOrder(filename);
        if (!rithumOrder) {
            results.failed.push({ file: filename, error: 'Failed to load' });
            continue;
        }
        
        console.log(`   Original PO: ${rithumOrder.poNumber}`);
        console.log(`   Original Order ID: ${rithumOrder.dscoOrderId}`);
        console.log(`   Lifecycle: ${rithumOrder.dscoLifecycle}`);
        console.log(`   Line Items: ${rithumOrder.lineItems?.length || 0}`);
        
        // Make it a test order
        const testOrder = makeTestOrder(rithumOrder, i);
        console.log(`   Test PO: ${testOrder.poNumber}`);
        console.log(`   Test Order ID: ${testOrder.dscoOrderId}`);
        
        // Map to ShipStation format
        console.log(`\n   🔄 Mapping to ShipStation format...`);
        const shipstationOrder = mapper.mapToShipStation(testOrder);
        
        console.log(`   ✅ Weight: ${shipstationOrder.weight?.value || 'N/A'} ${shipstationOrder.weight?.unit || ''}`);
        console.log(`   📦 Package: ${shipstationOrder.packageCode || 'N/A'}`);
        console.log(`   🚚 Service: ${shipstationOrder.serviceCode || 'N/A'}`);
        
        // Create in ShipStation
        console.log(`\n   📤 Creating order in ShipStation...`);
        
        try {
            const response = await shipstationClient.createOrder(shipstationOrder);
            console.log(`   ✅ SUCCESS! ShipStation Order ID: ${response.orderId || response.id || 'Created'}`);
            
            results.success.push({
                file: filename,
                originalPO: rithumOrder.poNumber,
                testPO: testOrder.poNumber,
                shipstationId: response.orderId || response.id,
                weight: shipstationOrder.weight,
                packageCode: shipstationOrder.packageCode
            });
        } catch (error) {
            console.log(`   ❌ FAILED: ${error.message}`);
            results.failed.push({
                file: filename,
                testPO: testOrder.poNumber,
                error: error.message
            });
        }
        
        // Rate limiting - wait 1 second between requests
        if (i < orderFiles.length - 1) {
            console.log(`   ⏳ Waiting 1 second before next order...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    // Summary
    console.log(`\n\n${'═'.repeat(80)}`);
    console.log(`\n📊 SUMMARY\n`);
    console.log(`Total Orders: ${orderFiles.length}`);
    console.log(`✅ Success: ${results.success.length}`);
    console.log(`❌ Failed: ${results.failed.length}`);
    
    if (results.success.length > 0) {
        console.log(`\n✅ Successfully Created Orders:`);
        results.success.forEach((order, idx) => {
            console.log(`   ${idx + 1}. ${order.testPO}`);
            console.log(`      ShipStation ID: ${order.shipstationId}`);
            console.log(`      Weight: ${order.weight?.value} ${order.weight?.unit}`);
            console.log(`      Package: ${order.packageCode}`);
        });
    }
    
    if (results.failed.length > 0) {
        console.log(`\n❌ Failed Orders:`);
        results.failed.forEach((order, idx) => {
            console.log(`   ${idx + 1}. ${order.testPO || order.file}`);
            console.log(`      Error: ${order.error}`);
        });
    }
    
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`\n✅ Test complete! Check ShipStation dashboard for created orders.`);
    console.log(`   Search for: "TEST-" prefix`);
}

// Run the script
createTestOrders().catch(error => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
});
