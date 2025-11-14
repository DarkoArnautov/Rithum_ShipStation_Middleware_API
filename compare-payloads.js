// Test to compare webhook payload format vs test-sync-shipment format
// to find the exact difference causing validation failure

const workingPayload = {
    dscoOrderId: '1026064165',
    poNumber: 'BOX.75594204.69954565',
    shipments: [{
        trackingNumber: '9400150206241019743462',
        shipDate: '2025-11-14T00:00:00Z',
        shipWeight: 2,
        shipWeightUnits: 'OZ',  // UPPERCASE
        shipCost: 0,             // EXPLICITLY 0
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

console.log('WORKING PAYLOAD (test-sync-shipment.js):');
console.log(JSON.stringify(workingPayload, null, 2));
console.log('\n' + '='.repeat(80));
console.log('\nKey fields that must match EXACTLY:');
console.log('  - shipWeightUnits: "OZ" (uppercase)');
console.log('  - shipCost: 0 (number, not null/undefined)');
console.log('  - All other fields present');
console.log('\nWebhook changes made:');
console.log('  ✅ Changed weight units to uppercase (OZ, LB, G, KG)');
console.log('  ✅ Always include shipCost (even if 0)');
console.log('  ✅ poNumber included');
console.log('  ✅ shipCarrier included');
console.log('  ✅ sku included in lineItems');
