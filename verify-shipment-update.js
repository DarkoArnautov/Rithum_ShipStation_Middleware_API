require('dotenv').config();
const RithumClient = require('./src/services/rithumClient');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

/**
 * Verify if a shipment was successfully added to a Rithum order
 * This is a workaround since we can't access the changelog endpoint
 */

async function verifyShipmentUpdate(rithumOrderId, trackingNumber, maxAttempts = 10, delayMs = 3000) {
    console.log(`\n🔍 Verifying shipment update for order: ${rithumOrderId}`);
    console.log(`   Tracking: ${trackingNumber}`);
    console.log(`   Will check ${maxAttempts} times with ${delayMs}ms delay between attempts`);
    console.log('='.repeat(80));
    
    try {
        validateRithumConfig();
        
        const rithumClient = new RithumClient(
            rithumConfig.apiUrl,
            rithumConfig.clientId,
            rithumConfig.clientSecret
        );
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`\n📋 Attempt ${attempt}/${maxAttempts}...`);
            
            try {
                // Search for the order
                const until = new Date().toISOString();
                const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
                
                const result = await rithumClient.fetchOrders({
                    ordersUpdatedSince: since,
                    until: until,
                    ordersPerPage: 100
                });
                
                const order = result.orders.find(o => o.dscoOrderId === rithumOrderId);
                
                if (!order) {
                    console.log(`   ❌ Order ${rithumOrderId} not found in recent orders`);
                    if (attempt < maxAttempts) {
                        console.log(`   ⏳ Waiting ${delayMs}ms before next attempt...`);
                        await sleep(delayMs);
                        continue;
                    }
                    return { success: false, reason: 'Order not found' };
                }
                
                console.log(`   ✅ Found order ${rithumOrderId}`);
                console.log(`   📦 Lifecycle: ${order.dscoLifecycle}`);
                console.log(`   📦 Packages: ${order.packages?.length || 0}`);
                
                // Check if the tracking number exists in packages
                if (order.packages && order.packages.length > 0) {
                    const matchingPackage = order.packages.find(pkg => 
                        pkg.trackingNumber === trackingNumber
                    );
                    
                    if (matchingPackage) {
                        console.log(`\n   ✅ SUCCESS! Shipment was added to order`);
                        console.log(`      Tracking: ${matchingPackage.trackingNumber}`);
                        console.log(`      Carrier: ${matchingPackage.shipCarrier || 'N/A'}`);
                        console.log(`      Method: ${matchingPackage.shipMethod || 'N/A'}`);
                        console.log(`      Ship Date: ${matchingPackage.shipDate || 'N/A'}`);
                        console.log(`      Items: ${matchingPackage.items?.length || 0}`);
                        
                        return {
                            success: true,
                            order: order,
                            package: matchingPackage,
                            lifecycle: order.dscoLifecycle
                        };
                    }
                }
                
                // Not found yet
                if (attempt < maxAttempts) {
                    console.log(`   ⏳ Shipment not found yet, waiting ${delayMs}ms...`);
                    await sleep(delayMs);
                } else {
                    console.log(`\n   ❌ FAILED: Shipment was NOT added after ${maxAttempts} attempts`);
                    console.log(`   📋 Order Details:`);
                    console.log(`      - Lifecycle: ${order.dscoLifecycle}`);
                    console.log(`      - Total Packages: ${order.packages?.length || 0}`);
                    if (order.packages && order.packages.length > 0) {
                        console.log(`      - Existing tracking numbers:`);
                        order.packages.forEach((pkg, i) => {
                            console.log(`        ${i + 1}. ${pkg.trackingNumber}`);
                        });
                    }
                    
                    return {
                        success: false,
                        reason: 'Shipment not added to order',
                        order: order,
                        lifecycle: order.dscoLifecycle,
                        packageCount: order.packages?.length || 0
                    };
                }
                
            } catch (error) {
                console.error(`   ❌ Error on attempt ${attempt}:`, error.message);
                if (attempt < maxAttempts) {
                    console.log(`   ⏳ Waiting ${delayMs}ms before next attempt...`);
                    await sleep(delayMs);
                } else {
                    throw error;
                }
            }
        }
        
    } catch (error) {
        console.error(`\n❌ Verification failed:`, error.message);
        throw error;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Run if called directly from command line
if (require.main === module) {
    const rithumOrderId = process.argv[2];
    const trackingNumber = process.argv[3];
    
    if (!rithumOrderId || !trackingNumber) {
        console.error('❌ Error: Please provide rithumOrderId and trackingNumber as arguments');
        console.log('\nUsage: node verify-shipment-update.js <rithumOrderId> <trackingNumber>');
        console.log('Example: node verify-shipment-update.js 1026063960 9400150206242019517336');
        process.exit(1);
    }
    
    verifyShipmentUpdate(rithumOrderId, trackingNumber)
        .then((result) => {
            if (result.success) {
                console.log('\n✅ Verification complete - Shipment successfully added!');
                process.exit(0);
            } else {
                console.log(`\n❌ Verification complete - Shipment NOT added: ${result.reason}`);
                process.exit(1);
            }
        })
        .catch((error) => {
            console.error('\n❌ Verification error:', error.message);
            process.exit(1);
        });
}

module.exports = { verifyShipmentUpdate };
