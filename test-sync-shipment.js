require('dotenv').config();
const RithumClient = require('./src/services/rithumClient');
const { rithumConfig } = require('./src/config/rithumConfig');

async function testSync() {
    const rithumClient = new RithumClient(rithumConfig.apiUrl, rithumConfig.clientId, rithumConfig.clientSecret);
    
    console.log('Testing SYNCHRONOUS endpoint /order/singleShipment...');
    console.log('Testing order 1026064165 that FAILED in Rithum portal\n');
    
    // This is the EXACT payload the webhook sent that resulted in "Validation failed"
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
    
    console.log('Payload:');
    console.log(JSON.stringify(payload, null, 2));
    console.log('');
    
    try {
        await rithumClient.ensureAccessToken();
        const response = await rithumClient.client.post('/order/singleShipment', payload);
        console.log('✅ SUCCESS! Status:', response.status);
        console.log('Response:', JSON.stringify(response.data, null, 2));
        
        // Wait a moment and verify
        console.log('\nWaiting 5 seconds to verify...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const until = new Date().toISOString();
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        const ordersResponse = await rithumClient.fetchOrders({
            ordersUpdatedSince: since,
            until: until,
            ordersPerPage: 100
        });
        
        const order = ordersResponse.orders.find(o => o.dscoOrderId === '1026064165');
        console.log('Order packages:', order.packages?.length || 0);
        if (order.packages && order.packages.length > 0) {
            console.log('✅ Package verified!');
            console.log(JSON.stringify(order.packages[0], null, 2));
        }
        
    } catch (error) {
        console.log('❌ ERROR! Status:', error.response?.status);
        console.log('Error details:');
        console.log(JSON.stringify(error.response?.data, null, 2));
        if (!error.response?.data) {
            console.log('Full error:', error.message);
        }
    }
}

testSync().catch(console.error);
