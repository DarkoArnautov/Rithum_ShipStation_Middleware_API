/**
 * Script to fetch new orders from Rithum, map them to ShipStation format, and create them in ShipStation
 * 
 * Flow:
 * 1. Fetch orders from Rithum API (directly via RithumClient)
 * 2. Map each Rithum order to ShipStation format (using OrderMapper)
 * 3. Create orders in ShipStation via /v2/shipments endpoint with create_sales_order: true
 * 4. Save results to output.json
 */
require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const OrderMapper = require('./src/services/orderMapper');
const ShipStationClient = require('./src/services/shipstationClient');
const RithumClient = require('./src/services/rithumClient');
const { shipstationConfig, validateConfig: validateShipStationConfig } = require('./src/config/shipstationConfig');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

const OUTPUT_FILE = path.join(__dirname, 'output.json');

async function fetchAndMapOrders() {
    try {
        console.log('📦 Fetch and Map Orders Script\n');
        console.log('='.repeat(80) + '\n');
        console.log('📋 Flow:');
        console.log('   1. Fetch orders from Rithum API (directly)');
        console.log('   2. Map Rithum orders to ShipStation format');
        console.log('   3. Create orders in ShipStation via /v2/shipments endpoint');
        console.log('   4. Save results to output.json\n');
        console.log('ℹ️  Using ShipStation API v2: Creating orders via /v2/shipments endpoint with create_sales_order: true\n');

        // Initialize Rithum client
        let rithumClient = null;
        try {
            validateRithumConfig();
            rithumClient = new RithumClient(
                rithumConfig.apiUrl,
                rithumConfig.clientId,
                rithumConfig.clientSecret
            );
            console.log('✅ Rithum client initialized\n');
        } catch (error) {
            console.error('❌ Failed to initialize Rithum client:', error.message);
            console.error('⚠️  Cannot fetch orders from Rithum.\n');
            process.exit(1);
        }

        // Initialize ShipStation client
        let shipstationClient = null;
        try {
            validateShipStationConfig();
            shipstationClient = new ShipStationClient(
                shipstationConfig.apiKey,
                shipstationConfig.baseUrl,
                shipstationConfig.warehouseId,
                shipstationConfig.shipFrom
            );
            console.log('✅ ShipStation client initialized\n');
        } catch (error) {
            console.error('❌ Failed to initialize ShipStation client:', error.message);
            console.error('⚠️  Will map orders but not create them in ShipStation.\n');
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
        const newOrderIds = rithumResponse.newOrderIds || [];

        console.log(`✅ Found ${newOrderCount} new order(s) from Rithum`);
        console.log(`📋 Order IDs: ${newOrderIds.length > 0 ? newOrderIds.slice(0, 5).join(', ') + (newOrderIds.length > 5 ? `... (+${newOrderIds.length - 5} more)` : '') : 'None'}\n`);

        if (!orders || orders.length === 0) {
            console.log('ℹ️  No orders to process.');
            await saveOutput({
                timestamp: new Date().toISOString(),
                totalOrders: 0,
                mappedOrders: [],
                createdOrders: [],
                errors: [],
                summary: {
                    mapped: 0,
                    created: 0,
                    failed: 0,
                    skipped: 0,
                    creationFailed: 0
                }
            });
            return;
        }

        // Step 2: Initialize mapper
        console.log('🔄 Step 2: Mapping orders to ShipStation format...\n');
        const mapper = new OrderMapper();
        const results = {
            timestamp: new Date().toISOString(),
            totalOrders: orders.length,
            mappedOrders: [],
            createdOrders: [],
            errors: [],
            summary: {
                mapped: 0,
                created: 0,
                failed: 0,
                skipped: 0,
                creationFailed: 0
            }
        };

        // Step 3: Process each order (Map and Create)
        for (let i = 0; i < orders.length; i++) {
            const order = orders[i];
            const orderId = order.id || order.dscoOrderId || `unknown-${i}`;
            
            // Skip if order has an error
            if (order.error) {
                results.summary.failed++;
                results.errors.push({
                    orderId,
                    poNumber: order.poNumber || 'N/A',
                    error: order.error,
                    timestamp: new Date().toISOString()
                });
                console.log(`❌ Order ${i + 1}/${orders.length} (${orderId}): ${order.error}`);
                continue;
            }

            // Check if should process
            if (!mapper.shouldProcess(order)) {
                results.summary.skipped++;
                console.log(`⏭️  Order ${i + 1}/${orders.length} (${orderId}): Skipped - status: ${order.dscoStatus || 'unknown'}`);
                continue;
            }

            // Validate and map
            const mappingResult = mapper.mapAndValidate(order);

            if (mappingResult.success) {
                results.summary.mapped++;
                const mappedOrderData = {
                    rithumOrderId: orderId,
                    poNumber: order.poNumber,
                    originalOrder: order,
                    shipstationOrder: mappingResult.mappedOrder,
                    mappedAt: new Date().toISOString()
                };
                
                console.log(`✅ Order ${i + 1}/${orders.length} (${orderId}): Mapped successfully`);
                console.log(`   PO Number: ${mappingResult.mappedOrder.orderNumber}`);
                console.log(`   Status: ${mappingResult.mappedOrder.orderStatus}`);
                console.log(`   Items: ${mappingResult.mappedOrder.items.length}`);

                // Create order in ShipStation
                if (shipstationClient) {
                    try {
                        console.log(`   🚀 Creating order in ShipStation via /v2/shipments endpoint...`);
                        console.log(`      (Using create_sales_order: true to create order)`);
                        const createdOrder = await shipstationClient.createOrder(mappingResult.mappedOrder);
                        
                        // Get ship_from address - check multiple sources
                        let shipFromAddress = null;
                        let warehouseId = null;
                        
                        // Priority 1: Check if ship_from is in the creation response
                        if (createdOrder.ship_from) {
                            shipFromAddress = createdOrder.ship_from;
                            console.log(`   📍 Ship From address from creation response`);
                        } else if (createdOrder.warehouse_id) {
                            warehouseId = createdOrder.warehouse_id;
                            console.log(`   📦 Warehouse ID from creation response: ${warehouseId}`);
                        }
                        
                        // Priority 2: Check if we sent ship_from (fallback reference)
                        if (!shipFromAddress && !warehouseId && createdOrder.sent_ship_from) {
                            shipFromAddress = createdOrder.sent_ship_from;
                            console.log(`   📍 Ship From address from sent data (fallback)`);
                        }
                        
                        // Priority 3: Fetch full shipment details if still missing
                        if (!shipFromAddress && !warehouseId && createdOrder.shipment_id) {
                            try {
                                console.log(`   🔍 Fetching full shipment details to get ship_from address...`);
                                const shipmentResponse = await shipstationClient.client.get(`/v2/shipments/${createdOrder.shipment_id}`);
                                const shipment = shipmentResponse.data;
                                if (shipment.ship_from) {
                                    shipFromAddress = shipment.ship_from;
                                    console.log(`   ✅ Ship From address retrieved from GET /v2/shipments/${createdOrder.shipment_id}`);
                                }
                                if (shipment.warehouse_id) {
                                    warehouseId = shipment.warehouse_id;
                                }
                            } catch (detailError) {
                                console.log(`   ⚠️  Could not retrieve shipment details: ${detailError.message}`);
                            }
                        }
                        
                        // If still no ship_from, check if we have the sent reference
                        if (!shipFromAddress && createdOrder.sent_ship_from) {
                            shipFromAddress = createdOrder.sent_ship_from;
                            console.log(`   📍 Using ship_from from sent data (ShipStation didn't return it in response)`);
                        }
                        
                        results.summary.created++;
                        mappedOrderData.shipstationCreated = true;
                        mappedOrderData.shipstationOrderId = createdOrder.sales_order_id || createdOrder.order_id || createdOrder.shipment_id || 'N/A';
                        mappedOrderData.shipstationOrderNumber = createdOrder.order_number || createdOrder.shipment_number || mappingResult.mappedOrder.orderNumber;
                        mappedOrderData.shipstationShipmentId = createdOrder.shipment_id || 'N/A';
                        mappedOrderData.shipFromAddress = shipFromAddress;
                        mappedOrderData.warehouseId = warehouseId;
                        mappedOrderData.createdAt = new Date().toISOString();
                        results.createdOrders.push(mappedOrderData);
                        
                        console.log(`   ✅ Order created in ShipStation:`);
                        console.log(`      Sales Order ID: ${mappedOrderData.shipstationOrderId}`);
                        console.log(`      Shipment ID: ${mappedOrderData.shipstationShipmentId}`);
                        if (shipFromAddress) {
                            console.log(`      Ship From: ${shipFromAddress.company_name || shipFromAddress.name || 'N/A'}, ${shipFromAddress.city_locality || 'N/A'}, ${shipFromAddress.state_province || 'N/A'}`);
                        } else if (warehouseId) {
                            console.log(`      Warehouse ID: ${warehouseId}`);
                        }
                    } catch (createError) {
                        results.summary.creationFailed++;
                        mappedOrderData.shipstationCreated = false;
                        mappedOrderData.creationError = {
                            message: createError.message,
                            status: createError.response?.status,
                            data: createError.response?.data
                        };
                        
                        results.errors.push({
                            orderId,
                            poNumber: order.poNumber || 'N/A',
                            error: 'Failed to create order in ShipStation',
                            creationError: mappedOrderData.creationError,
                            timestamp: new Date().toISOString()
                        });
                        
                        console.log(`   ❌ Failed to create order in ShipStation: ${createError.message}`);
                        if (createError.response?.data) {
                            console.log(`   Error details:`, JSON.stringify(createError.response.data, null, 2));
                            // Check if it's the old endpoint error
                            if (createError.response.data.errors && 
                                createError.response.data.errors.some(e => e.path && e.path.includes('/v2/orders/createorder'))) {
                                console.log(`   ⚠️  This error suggests the old /v2/orders/createorder endpoint was used.`);
                                console.log(`   The code should use /v2/shipments with create_sales_order: true instead.`);
                            }
                        }
                    }
                } else {
                    console.log(`   ⚠️  Skipping ShipStation creation (client not initialized)`);
                }

                results.mappedOrders.push(mappedOrderData);
            } else {
                results.summary.failed++;
                results.errors.push({
                    orderId,
                    poNumber: order.poNumber || 'N/A',
                    errors: mappingResult.errors,
                    validationErrors: mappingResult.validation?.errors || [],
                    timestamp: new Date().toISOString()
                });
                console.log(`❌ Order ${i + 1}/${orders.length} (${orderId}): Failed to map`);
                console.log(`   Errors: ${mappingResult.errors.join(', ')}`);
            }
        }

        // Add metadata about the position update
        results.lastPosition = rithumResponse.lastPosition;
        results.streamId = rithumResponse.streamId;

        // Save to output.json
        await saveOutput(results);

        // Print summary
        console.log('\n' + '='.repeat(80));
        console.log('\n📊 Summary:');
        console.log(`   Total Orders: ${results.totalOrders}`);
        console.log(`   ✅ Successfully Mapped: ${results.summary.mapped}`);
        if (shipstationClient) {
            console.log(`   🚀 Created in ShipStation (via /v2/shipments): ${results.summary.created}`);
            if (results.summary.creationFailed > 0) {
                console.log(`   ❌ Creation Failed: ${results.summary.creationFailed}`);
            }
        } else {
            console.log(`   ⚠️  ShipStation creation skipped (client not initialized)`);
        }
        console.log(`   ❌ Mapping Failed: ${results.summary.failed}`);
        console.log(`   ⏭️  Skipped: ${results.summary.skipped}`);
        console.log(`   📍 Last Position: ${rithumResponse.lastPosition}`);
        console.log(`   📡 Stream ID: ${rithumResponse.streamId}`);
        console.log(`\n💾 Results saved to: ${OUTPUT_FILE}\n`);
        
        if (rithumResponse.lastPosition) {
            console.log(`ℹ️  Note: Stream position has been updated to prevent re-processing these orders.`);
            console.log(`   Next run will fetch orders after position: ${rithumResponse.lastPosition}\n`);
        }

        if (results.errors.length > 0) {
            console.log('⚠️  Errors encountered:');
            results.errors.forEach((error, index) => {
                console.log(`\n   ${index + 1}. Order ${error.poNumber || error.orderId || 'Unknown'}:`);
                if (error.error) {
                    console.log(`      - ${error.error}`);
                }
                if (error.errors) {
                    error.errors.forEach(err => console.log(`      - ${err}`));
                }
                if (error.validationErrors && error.validationErrors.length > 0) {
                    error.validationErrors.forEach(err => console.log(`      - Validation: ${err}`));
                }
            });
        }

    } catch (error) {
        console.error('\n❌ Error:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
            console.error('No response received. Is the server running?');
        } else {
            console.error('Error:', error.message);
        }
        process.exit(1);
    }
}

async function saveOutput(data) {
    try {
        await fs.writeFile(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf8');
        console.log(`\n✅ Saved results to ${OUTPUT_FILE}`);
    } catch (error) {
        console.error(`\n❌ Failed to save output file: ${error.message}`);
        throw error;
    }
}

// Run the script
fetchAndMapOrders();

