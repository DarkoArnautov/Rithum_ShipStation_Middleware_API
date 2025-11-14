require('dotenv').config();
const RithumClient = require('./src/services/rithumClient');
const { rithumConfig } = require('./src/config/rithumConfig');

async function testBothEndpoints() {
    const rithumClient = new RithumClient(rithumConfig.apiUrl, rithumConfig.clientId, rithumConfig.clientSecret);
    await rithumClient.ensureAccessToken();
    
    // This is the EXACT payload the webhook sent that failed
    const payload = {
        dscoOrderId: '1026064165',
        poNumber: 'BOX.75594204.69954565',
        shipments: [{
            trackingNumber: '9400150206241019743462',
            shipDate: '2025-11-14T00:00:00Z',
            shipWeight: 2,
            shipWeightUnits: 'OZ',
            shipCost: 0,
            carrierManifestId: 'USPS',
            shipCarrier: 'USPS',
            shippingServiceLevelCode: 'USGA',
            shipMethod: 'Ground Advantage',
            lineItems: [
                { 
                    quantity: 1, 
                    dscoItemId: '1296623849',
                    sku: 'JAX-FA-083-DS'
                }
            ]
        }]
    };
    
    console.log('Testing SAME payload on BOTH endpoints...\n');
    console.log('Payload:');
    console.log(JSON.stringify(payload, null, 2));
    console.log('\n' + '='.repeat(80) + '\n');
    
    // Test 1: SYNCHRONOUS endpoint
    console.log('TEST 1: SYNCHRONOUS /order/singleShipment');
    console.log('-'.repeat(80));
    try {
        const syncResponse = await rithumClient.client.post('/order/singleShipment', payload);
        console.log('✅ SUCCESS! Status:', syncResponse.status);
        console.log('Response:', JSON.stringify(syncResponse.data, null, 2));
    } catch (error) {
        console.log('❌ FAILED! Status:', error.response?.status);
        console.log('Error:', JSON.stringify(error.response?.data, null, 2));
    }
    
    console.log('\n' + '='.repeat(80) + '\n');
    
    // Test 2: ASYNCHRONOUS endpoint (what webhook uses)
    console.log('TEST 2: ASYNCHRONOUS /order/shipment/batch/small');
    console.log('-'.repeat(80));
    try {
        const asyncResponse = await rithumClient.client.post('/order/shipment/batch/small', [payload]);
        console.log('✅ ACCEPTED! Status:', asyncResponse.status);
        console.log('Response:', JSON.stringify(asyncResponse.data, null, 2));
        console.log('\nℹ️  Note: 202 Accepted means validation happens later');
        console.log('   RequestId:', asyncResponse.data.requestId);
        
        // Wait and check order
        console.log('\nWaiting 10 seconds for async processing...');
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        const until = new Date().toISOString();
        const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        const ordersResponse = await rithumClient.fetchOrders({
            ordersUpdatedSince: since,
            until: until,
            ordersPerPage: 100
        });
        
        const order = ordersResponse.orders.find(o => o.dscoOrderId === '1026064165');
        console.log('\nOrder verification:');
        console.log('  Packages:', order.packages?.length || 0);
        console.log('  Lifecycle:', order.dscoLifecycle);
        
        if (order.packages && order.packages.length > 0) {
            console.log('  ✅ Shipment was added successfully!');
        } else {
            console.log('  ⏳ Still processing or ❌ validation failed');
        }
        
    } catch (error) {
        console.log('❌ FAILED! Status:', error.response?.status);
        console.log('Error:', JSON.stringify(error.response?.data, null, 2));
    }
}

testBothEndpoints().catch(console.error);
