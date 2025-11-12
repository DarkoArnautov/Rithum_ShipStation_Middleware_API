require('dotenv').config();
const RithumClient = require('./src/services/rithumClient');
const { rithumConfig } = require('./src/config/rithumConfig');

async function getOrderDetails(orderId) {
    try {
        console.log('🔍 Fetching order details from Rithum...');
        console.log('   Order ID:', orderId, '\n');
        
        // Use the proper RithumClient
        const rithumClient = new RithumClient(
            rithumConfig.apiUrl,
            rithumConfig.clientId,
            rithumConfig.clientSecret
        );
        
        console.log('✅ RithumClient initialized\n');
        
        // Use /order/page with time range to find the order
        console.log('Fetching orders using /order/page endpoint...\n');
        const until = new Date(Date.now() - 5000).toISOString(); // 5 seconds ago (required by API)
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
        
        const orderResponse = await rithumClient.makeRequest('GET', '/order/page', null, {
            ordersUpdatedSince: since,
            until: until,
            ordersPerPage: 100
        });
        
        console.log(`Found ${orderResponse.orders?.length || 0} orders\n`);
        
        const orders = orderResponse.orders || [];
        const order = orders.find(o => o.dscoOrderId === orderId);
        
        if (!order) {
            console.error('❌ Order not found');
            process.exit(1);
        }
        
        console.log('📦 Order Details:');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('Order ID:', order.dscoOrderId);
        console.log('PO Number:', order.poNumber);
        console.log('Status:', order.status);
        console.log('Lifecycle:', order.dscoLifecycle);
        console.log('Order Date:', order.orderDate);
        console.log('\n📋 Line Items:');
        console.log('─────────────────────────────────────────────────────────');
        
        if (order.lineItems && order.lineItems.length > 0) {
            order.lineItems.forEach((item, index) => {
                console.log(`\nItem ${index + 1}:`);
                console.log('  dscoItemId:', item.dscoItemId);
                console.log('  SKU:', item.sku);
                console.log('  Partner SKU:', item.partnerSku);
                console.log('  Title:', item.title);
                console.log('  Quantity:', item.quantity);
                console.log('  Line Number:', item.lineNumber);
            });
        }
        
        console.log('\n\n📦 Existing Shipments:');
        console.log('─────────────────────────────────────────────────────────');
        
        if (order.shipments && order.shipments.length > 0) {
            order.shipments.forEach((shipment, index) => {
                console.log(`\nShipment ${index + 1}:`);
                console.log('  Tracking:', shipment.trackingNumber);
                console.log('  Carrier:', shipment.shipCarrier);
                console.log('  Method:', shipment.shipMethod);
                console.log('  Service Level Code:', shipment.shippingServiceLevelCode);
                console.log('  Ship Date:', shipment.shipDate);
                console.log('  Ship Cost:', shipment.shipCost);
                console.log('  Ship Weight:', shipment.shipWeight, shipment.shipWeightUnits);
                if (shipment.lineItems) {
                    console.log('  Line Items:');
                    shipment.lineItems.forEach(li => {
                        console.log(`    - dscoItemId: ${li.dscoItemId}, quantity: ${li.quantity}`);
                    });
                }
            });
        } else {
            console.log('No shipments found');
        }
        
        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('\n📄 Full order JSON:\n');
        console.log(JSON.stringify(order, null, 2));
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response?.data) {
            console.error('Response:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

const orderId = process.argv[2] || '1025416768';
getOrderDetails(orderId).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
