require('dotenv').config();
const ShipStationClient = require('./src/services/shipstationClient');
const RithumClient = require('./src/services/rithumClient');
const { shipstationConfig, validateConfig: validateShipStationConfig } = require('./src/config/shipstationConfig');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');
const { verifyShipmentUpdate } = require('./verify-shipment-update');

/**
 * Retry a failed shipment submission to Rithum
 * This script builds the correct payload with proper shipping codes
 */

async function retryFailedShipment(shipmentId, rithumOrderId) {
    console.log(`\n🔄 RETRYING FAILED SHIPMENT`);
    console.log('═'.repeat(80));
    console.log(`   ShipStation Shipment ID: ${shipmentId}`);
    console.log(`   Rithum Order ID: ${rithumOrderId}`);
    console.log('═'.repeat(80) + '\n');
    
    try {
        // Validate configs
        validateShipStationConfig();
        validateRithumConfig();
        
        // Initialize clients
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
        
        // Step 1: Fetch shipment from ShipStation
        console.log(`📦 Step 1: Fetching shipment from ShipStation...`);
        const shipment = await shipstationClient.getShipmentById(shipmentId);
        console.log(`   ✅ Shipment retrieved: ${shipment.shipment_number}`);
        console.log(`   Status: ${shipment.shipment_status}`);
        console.log(`   Service: ${shipment.service_code}`);
        
        // Step 2: Get tracking info
        console.log(`\n🔍 Step 2: Getting tracking information...`);
        const trackingInfo = await shipstationClient.getShipmentTracking(shipmentId);
        
        // Fetch labels for tracking number if not in shipment
        let trackingNumber = trackingInfo.tracking_number;
        if (!trackingNumber) {
            console.log(`   ⚠️  No tracking in shipment, fetching from labels...`);
            try {
                const labelsResponse = await shipstationClient.client.get('/v2/labels', {
                    params: { shipment_id: shipmentId }
                });
                const labels = labelsResponse.data?.labels || labelsResponse.data || [];
                if (labels.length > 0 && labels[0].tracking_number) {
                    trackingNumber = labels[0].tracking_number;
                    console.log(`   ✅ Found tracking from label: ${trackingNumber}`);
                }
            } catch (error) {
                console.warn(`   ⚠️  Could not fetch labels: ${error.message}`);
            }
        } else {
            console.log(`   ✅ Tracking number: ${trackingNumber}`);
        }
        
        if (!trackingNumber) {
            throw new Error('No tracking number found for shipment');
        }
        
        // Step 3: Check Rithum order current state
        console.log(`\n📋 Step 3: Checking Rithum order state...`);
        const until = new Date().toISOString();
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        
        const ordersResponse = await rithumClient.fetchOrders({
            ordersUpdatedSince: since,
            until: until,
            ordersPerPage: 100
        });
        
        const rithumOrder = ordersResponse.orders.find(o => o.dscoOrderId === rithumOrderId);
        
        if (!rithumOrder) {
            throw new Error(`Order ${rithumOrderId} not found in Rithum`);
        }
        
        console.log(`   ✅ Found order: ${rithumOrder.poNumber}`);
        console.log(`   Lifecycle: ${rithumOrder.dscoLifecycle}`);
        console.log(`   Status: ${rithumOrder.dscoStatus}`);
        console.log(`   Current packages: ${rithumOrder.packages?.length || 0}`);
        
        // Check if already has this tracking
        if (rithumOrder.packages && rithumOrder.packages.length > 0) {
            const existingPackage = rithumOrder.packages.find(pkg => pkg.trackingNumber === trackingNumber);
            if (existingPackage) {
                console.log(`\n   ⚠️  WARNING: Tracking ${trackingNumber} already exists on order!`);
                console.log(`      Package added at: ${existingPackage.shipDate}`);
                console.log(`      This may be a duplicate. Continue anyway? (Already succeeded previously)`);
                return {
                    success: true,
                    alreadyExists: true,
                    package: existingPackage
                };
            }
        }
        
        // Verify lifecycle is valid
        const validLifecycles = ['acknowledged', 'completed'];
        if (!validLifecycles.includes(rithumOrder.dscoLifecycle)) {
            throw new Error(`Order lifecycle is "${rithumOrder.dscoLifecycle}" - must be "acknowledged" or "completed"`);
        }
        
        // Step 4: Build correct shipment payload
        console.log(`\n🔨 Step 4: Building shipment payload...`);
        
        // Extract line items
        const items = shipment.items || [];
        const lineItems = items.map(item => {
            const quantity = Number(item.quantity || item.ordered_quantity || 1);
            if (!quantity || quantity <= 0) return null;
            
            const lineItem = { quantity };
            
            const dscoItemId = item.external_order_item_id || item.sales_order_item_id;
            if (dscoItemId) {
                lineItem.dscoItemId = String(dscoItemId);
            } else if (item.sku) {
                lineItem.sku = String(item.sku);
            } else if (item.partner_sku) {
                lineItem.partnerSku = String(item.partner_sku);
            } else if (item.upc) {
                lineItem.upc = String(item.upc);
            } else {
                return null;
            }
            
            return lineItem;
        }).filter(Boolean);
        
        if (lineItems.length === 0) {
            throw new Error('No valid line items found in shipment');
        }
        
        console.log(`   ✅ Line items: ${lineItems.length}`);
        
        // Map shipping code - THIS IS THE FIX!
        const serviceCode = shipment.service_code || '';
        let shippingServiceLevelCode;
        
        console.log(`   📋 Service code from ShipStation: "${serviceCode}"`);
        
        // Map based on service code
        if (serviceCode.includes('usps')) {
            if (serviceCode.includes('priority')) {
                shippingServiceLevelCode = 'USPM'; // USPS Priority Mail
            } else if (serviceCode.includes('ground_advantage') || serviceCode.includes('ground')) {
                shippingServiceLevelCode = 'USGA'; // USPS Ground Advantage
            } else {
                shippingServiceLevelCode = 'USGA'; // Default USPS
            }
        } else if (serviceCode.includes('ups')) {
            if (serviceCode.includes('ground')) {
                shippingServiceLevelCode = 'UPCG'; // UPS Ground
            } else if (serviceCode.includes('next_day')) {
                shippingServiceLevelCode = 'UPSV'; // UPS Next Day
            } else if (serviceCode.includes('2nd_day') || serviceCode.includes('2day')) {
                shippingServiceLevelCode = 'UPSP'; // UPS 2nd Day
            } else {
                shippingServiceLevelCode = 'UPCG'; // Default UPS
            }
        } else if (serviceCode.includes('fedex')) {
            if (serviceCode.includes('ground')) {
                shippingServiceLevelCode = 'FECG'; // FedEx Ground
            } else if (serviceCode.includes('2day')) {
                shippingServiceLevelCode = 'FEHD'; // FedEx 2Day
            } else {
                shippingServiceLevelCode = 'FESP'; // FedEx Express
            }
        } else {
            // Default based on carrier_id
            const carrierId = String(shipment.carrier_id || '').toLowerCase();
            if (carrierId.includes('usps') || carrierId.includes('287927')) {
                shippingServiceLevelCode = 'USGA';
            } else if (carrierId.includes('ups')) {
                shippingServiceLevelCode = 'UPCG';
            } else {
                shippingServiceLevelCode = 'USGA'; // Safe default
            }
        }
        
        console.log(`   ✅ Mapped to shipping code: ${shippingServiceLevelCode}`);
        
        // Validate the code
        const validCodes = ['ASEE', 'ASEP', 'ASEL', 'ASET', 'FECG', 'FEHD', 'FESP', 'ONCG', 'PSDD', 'UPCG', 'UPSV', 'UPSP', 'USGA', 'USPM'];
        if (!validCodes.includes(shippingServiceLevelCode)) {
            throw new Error(`Mapped shipping code "${shippingServiceLevelCode}" is not valid! Valid codes: ${validCodes.join(', ')}`);
        }
        
        // Get carrier manifest ID
        const carrierManifestIdMap = {
            'usps': 'USPS',
            'ups': 'UPS',
            'fedex': 'FedEx',
            'ontrac': 'OnTrac'
        };
        
        let carrierManifestId = 'USPS'; // Default
        for (const [key, value] of Object.entries(carrierManifestIdMap)) {
            if (serviceCode.includes(key)) {
                carrierManifestId = value;
                break;
            }
        }
        
        console.log(`   ✅ Carrier: ${carrierManifestId}`);
        
        // Get weight
        const weight = shipment.total_weight?.value || shipment.packages?.[0]?.weight?.value || 1;
        const weightUnit = shipment.total_weight?.unit || shipment.packages?.[0]?.weight?.unit || 'ounce';
        
        // Map weight unit
        const weightUnitMap = {
            'oz': 'oz', 'ounce': 'oz', 'ounces': 'oz',
            'lb': 'LB', 'lbs': 'LB', 'pound': 'LB', 'pounds': 'LB',
            'g': 'g', 'gram': 'g', 'grams': 'g',
            'kg': 'kg', 'kilogram': 'kg', 'kilograms': 'kg'
        };
        const shipWeightUnits = weightUnitMap[weightUnit.toLowerCase()] || 'oz';
        
        console.log(`   ✅ Weight: ${weight} ${shipWeightUnits}`);
        
        // Ship date
        const shipDate = shipment.ship_date || new Date().toISOString();
        
        // Build payload
        const shipmentData = {
            dscoOrderId: rithumOrderId,
            shipments: [{
                trackingNumber: trackingNumber,
                shipDate: shipDate,
                shipWeight: parseFloat(weight),
                shipWeightUnits: shipWeightUnits,
                shipCost: shipment.shipping_amount?.amount || 0,
                carrierManifestId: carrierManifestId,
                shippingServiceLevelCode: shippingServiceLevelCode,
                shipMethod: shippingServiceLevelCode === 'USGA' ? 'Ground Advantage' : 'Ground',
                lineItems: lineItems
            }]
        };
        
        console.log(`\n📋 Final Payload:`);
        console.log(JSON.stringify(shipmentData, null, 2));
        
        // Step 5: Submit to Rithum
        console.log(`\n🚀 Step 5: Submitting shipment to Rithum...`);
        const response = await rithumClient.createShipments(shipmentData);
        
        console.log(`   ✅ Submitted successfully!`);
        console.log(`   Request ID: ${response.requestId}`);
        console.log(`   Status: ${response.status}`);
        if (response.messages) {
            response.messages.forEach(msg => {
                console.log(`   Message: [${msg.severity}] ${msg.code} - ${msg.description}`);
            });
        }
        
        // Step 6: Verify shipment was added
        console.log(`\n✅ Step 6: Verifying shipment was added...`);
        console.log(`   Waiting 5 seconds before checking...`);
        await sleep(5000);
        
        const verification = await verifyShipmentUpdate(rithumOrderId, trackingNumber, 10, 3000);
        
        if (verification.success) {
            console.log(`\n🎉 SUCCESS! Shipment was added to Rithum order!`);
            console.log(`   Package details:`);
            console.log(`      Tracking: ${verification.package.trackingNumber}`);
            console.log(`      Carrier: ${verification.package.shipCarrier}`);
            console.log(`      Method: ${verification.package.shipMethod}`);
            console.log(`      Items: ${verification.package.items?.length || 0}`);
            console.log(`   Order lifecycle: ${verification.lifecycle}`);
        } else {
            console.log(`\n⚠️  WARNING: Shipment submission succeeded but verification failed`);
            console.log(`   Reason: ${verification.reason}`);
            console.log(`   The shipment may still be processing asynchronously`);
            console.log(`   Check order ${rithumOrderId} in Rithum portal`);
        }
        
        return {
            success: verification.success,
            response: response,
            verification: verification,
            payload: shipmentData
        };
        
    } catch (error) {
        console.error(`\n❌ Retry failed:`, error.message);
        if (error.response?.data) {
            console.error(`   API Error:`, JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Run if called directly
if (require.main === module) {
    const shipmentId = process.argv[2] || 'se-920983006';
    const rithumOrderId = process.argv[3] || '1026063960';
    
    console.log('\n🔧 SHIPMENT RETRY TOOL');
    console.log('═'.repeat(80));
    
    retryFailedShipment(shipmentId, rithumOrderId)
        .then((result) => {
            if (result.success) {
                console.log('\n✅ RETRY SUCCESSFUL!');
                console.log('═'.repeat(80));
                process.exit(0);
            } else if (result.alreadyExists) {
                console.log('\n✅ SHIPMENT ALREADY EXISTS (Previously succeeded)');
                console.log('═'.repeat(80));
                process.exit(0);
            } else {
                console.log('\n⚠️  RETRY COMPLETED BUT VERIFICATION FAILED');
                console.log('   Check Rithum order manually');
                console.log('═'.repeat(80));
                process.exit(1);
            }
        })
        .catch((error) => {
            console.error('\n❌ RETRY FAILED');
            console.error('═'.repeat(80));
            process.exit(1);
        });
}

module.exports = { retryFailedShipment };
