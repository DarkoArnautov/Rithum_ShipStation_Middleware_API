require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const OrderMapper = require('./src/services/orderMapper');
const ShipStationClient = require('./src/services/shipstationClient');
const RithumClient = require('./src/services/rithumClient');
const CarrierSelector = require('./src/services/carrierSelector');
const { shipstationConfig, validateConfig: validateShipStationConfig } = require('./src/config/shipstationConfig');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

const OUTPUT_FILE = path.join(__dirname, 'output.json');

async function fetchAndMapOrders() {
    try {
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
            process.exit(1);
        }

        let shipstationClient = null;
        let shipFromAddress = null;
        let warehouseId = null;
        let carrierSelector = null;
        
        try {
            validateShipStationConfig();
            shipstationClient = new ShipStationClient(
                shipstationConfig.apiKey,
                shipstationConfig.baseUrl,
                shipstationConfig.warehouseId,
                shipstationConfig.shipFrom
            );
            console.log('✅ ShipStation client initialized\n');
            
            // Initialize carrier selector
            carrierSelector = new CarrierSelector(shipstationClient);
            console.log('✅ Carrier selector initialized\n');
            
            // Fetch ship_from address from ShipStation warehouses API if not already configured
            if (!shipstationConfig.shipFrom && !shipstationConfig.warehouseId) {
                console.log('📦 Fetching warehouses from ShipStation to get ship_from address...\n');
                try {
                    const warehouses = await shipstationClient.getWarehouses();
                    console.log(`   Found ${warehouses ? warehouses.length : 0} warehouse(s) in ShipStation`);
                    
                    if (warehouses && warehouses.length > 0) {
                        const defaultWarehouse = warehouses.find(w => w.is_default === true);
                        const warehouse = defaultWarehouse || warehouses[0];
                        warehouseId = warehouse.warehouse_id;
                        
                        if (warehouse.origin_address) {
                            const originAddr = warehouse.origin_address;
                            shipFromAddress = {
                                name: originAddr.name || warehouse.name || 'Ship From',
                                company_name: originAddr.company_name || originAddr.name || warehouse.name,
                                address_line1: originAddr.address_line1 || originAddr.street1 || originAddr.address1 || '',
                                address_line2: originAddr.address_line2 || originAddr.street2 || originAddr.address2 || '',
                                city_locality: originAddr.city_locality || originAddr.city || '',
                                state_province: originAddr.state_province || originAddr.state || '',
                                postal_code: originAddr.postal_code || originAddr.postalCode || originAddr.zip || '',
                                country_code: originAddr.country_code || originAddr.country || 'US',
                                phone: originAddr.phone || '',
                                email: originAddr.email || '',
                                address_residential_indicator: originAddr.address_residential_indicator || 'no'
                            };
                            console.log(`✅ Extracted ship_from address from warehouse origin_address: ${warehouse.name || warehouseId}`);
                        } else {
                            console.log(`⚠️  Warehouse ${warehouseId} found but no origin_address available.`);
                        }
                    } else {
                        console.log('⚠️  No warehouses found in ShipStation.');
                    }
                } catch (warehouseError) {
                    console.warn(`⚠️  Could not fetch warehouses: ${warehouseError.message}`);
                }
            } else if (shipstationConfig.shipFrom) {
                shipFromAddress = shipstationConfig.shipFrom;
                console.log('✅ Using ship_from address from configuration\n');
            } else if (shipstationConfig.warehouseId) {
                warehouseId = shipstationConfig.warehouseId;
                console.log(`✅ Using warehouse ID from configuration: ${warehouseId}\n`);
            }
        } catch (error) {
            console.error('❌ Failed to initialize ShipStation client:', error.message);
        }

        console.log('📥 Fetching new orders from Rithum Event Stream...\n');
        const rithumResponse = await rithumClient.checkForNewOrders(
            true,                    
            'acknowledged',          
            ['update_status_lifecycle']
        );

        if (!rithumResponse.success) {
            console.error('❌ Failed to fetch orders from Rithum:', rithumResponse.error || 'Unknown error');
            process.exit(1);
        }
        const orders = rithumResponse.orderDetails || [];
        const newOrderCount = rithumResponse.newOrderCount || 0;

        console.log(`✅ Found ${newOrderCount} new order event(s) from Rithum Stream`);

        if (!orders || orders.length === 0) {
            console.log('ℹ️  No new orders to process.');
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
                },
                lastPosition: rithumResponse.lastPosition,
                streamId: rithumResponse.streamId
            });
            return;
        }

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
            },
            lastPosition: rithumResponse.lastPosition,
            streamId: rithumResponse.streamId,
            processingStartedAt: new Date().toISOString()
        };

        if (orders.length > 0) {
            console.log('🔄 Mapping orders to ShipStation v2 format...\n');
            const mapper = new OrderMapper();

            // Process each order (Map and Create)
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
                    console.log(`   Status: ${mappingResult.mappedOrder.orderStatus}`);
                    console.log(`   Order Number: ${mappingResult.mappedOrder.orderNumber}`);
                    console.log(`   PO Number: ${order.poNumber || 'N/A'}`);
                    if (mappingResult.mappedOrder.shipmentNumber) {
                        console.log(`   Shipment Number: ${mappingResult.mappedOrder.shipmentNumber}`);
                    }
                    // Create order in ShipStation
                    if (shipstationClient) {
                        try {
                            // Comprehensive check if order already exists in ShipStation
                            const orderCheckData = {
                                orderNumber: mappingResult.mappedOrder.orderNumber,
                                poNumber: order.poNumber,
                                shipmentNumber: mappingResult.mappedOrder.shipmentNumber
                            };
                            
                            const existenceCheck = await shipstationClient.checkOrderExists(orderCheckData);
                            
                            if (existenceCheck.found) {
                                const existingShipment = existenceCheck.shipment;
                                console.log(`   ⏭️  Order already exists in ShipStation via ${existenceCheck.method}`);
                                console.log(`   📋 Existing Shipment ID: ${existingShipment.shipment_id}, Status: ${existingShipment.shipment_status || 'N/A'}`);
                                
                                results.summary.skipped++;
                                mappedOrderData.shipstationCreated = false;
                                mappedOrderData.shipstationSkipped = true;
                                mappedOrderData.shipstationOrderId = existingShipment.sales_order_id || existingShipment.shipment_id || 'N/A';
                                mappedOrderData.shipstationOrderNumber = existingShipment.shipment_number || existingShipment.external_shipment_id || orderCheckData.orderNumber;
                                mappedOrderData.shipstationShipmentId = existingShipment.shipment_id || 'N/A';
                                mappedOrderData.existingShipmentStatus = existingShipment.shipment_status || 'N/A';
                                mappedOrderData.duplicateCheckMethod = existenceCheck.method;
                                mappedOrderData.duplicateCheckIdentifier = existenceCheck.identifier;
                                mappedOrderData.skippedAt = new Date().toISOString();
                                results.mappedOrders.push(mappedOrderData);
                                continue; // Skip to next order
                            } else {
                                console.log(`   ✅ Order verified as new - proceeding with creation...`);
                            }
                            
                            const orderWithShipFrom = { ...mappingResult.mappedOrder };
                            if (shipFromAddress) {
                                orderWithShipFrom.shipFrom = shipFromAddress;
                            } else if (warehouseId) {
                                orderWithShipFrom.warehouse_id = warehouseId;
                            } else {
                                console.log(`      ⚠️  No ship_from address or warehouse_id available - order may fail`);
                            }
                            
                            // 🚀 INTELLIGENT CARRIER SELECTION WITH RITHUM REQUIREMENTS
                            // Select appropriate carrier based on order characteristics AND Rithum requirements
                            let selectedCarrierId = null;
                            
                            if (carrierSelector) {
                                try {
                                    selectedCarrierId = await carrierSelector.selectCarrier(
                                        mappingResult.mappedOrder,
                                        mappingResult.mappedOrder.shipTo,
                                        order  // Pass original Rithum order data for carrier requirements
                                    );
                                    
                                    if (selectedCarrierId) {
                                        console.log(`   🚚 Selected carrier: ${selectedCarrierId} (respects Rithum requirements)`);
                                    } else {
                                        console.log(`   ⚠️  No suitable carrier found via intelligent selection`);
                                    }
                                } catch (carrierError) {
                                    console.error(`   ❌ Carrier selection failed: ${carrierError.message}`);
                                    selectedCarrierId = null;
                                }
                            } else {
                                console.log(`   ⚠️  Carrier selector not available`);
                            }
                            
                            // 🛡️ FALLBACK CARRIER ASSIGNMENT
                            // Ensure carrierId is always set to prevent "carrier_id is required" error
                            if (!selectedCarrierId) {
                                selectedCarrierId = 'se-287927'; // Primary USPS as ultimate fallback
                                console.log(`   🚨 Using fallback carrier: ${selectedCarrierId} (Primary USPS)`);
                                console.log(`   💡 Reason: Intelligent selection failed or unavailable`);
                            }
                            
                            // Always assign the carrier ID
                            orderWithShipFrom.carrierId = selectedCarrierId;
                            
                            const createdOrder = await shipstationClient.createOrder(orderWithShipFrom);
                            
                            let createdShipFrom = createdOrder.ship_from || null;
                            let createdWarehouseId = createdOrder.warehouse_id || null;
                            
                            if (!createdShipFrom && !createdWarehouseId && createdOrder.sent_ship_from) {
                                createdShipFrom = createdOrder.sent_ship_from;
                            }
                            
                            if (!createdShipFrom && !createdWarehouseId && createdOrder.shipment_id) {
                                try {
                                    const shipmentResponse = await shipstationClient.client.get(`/v2/shipments/${createdOrder.shipment_id}`);
                                    const shipment = shipmentResponse.data;
                                    if (shipment.ship_from) {
                                        createdShipFrom = shipment.ship_from;
                                    }
                                    if (shipment.warehouse_id) {
                                        createdWarehouseId = shipment.warehouse_id;
                                    }
                                } catch (detailError) {
                                    console.log(`   ⚠️  Could not retrieve shipment details: ${detailError.message}`);
                                }
                            }
                            
                            if (!createdShipFrom && shipFromAddress) {
                                createdShipFrom = shipFromAddress;
                            }
                            if (!createdWarehouseId && warehouseId) {
                                createdWarehouseId = warehouseId;
                            }
                            
                            results.summary.created++;
                            mappedOrderData.shipstationCreated = true;
                            mappedOrderData.shipstationOrderId = createdOrder.sales_order_id || createdOrder.order_id || createdOrder.shipment_id || 'N/A';
                            mappedOrderData.shipstationOrderNumber = createdOrder.order_number || createdOrder.shipment_number || mappingResult.mappedOrder.orderNumber;
                            mappedOrderData.shipstationShipmentId = createdOrder.shipment_id || 'N/A';
                            mappedOrderData.shipFromAddress = createdShipFrom;
                            mappedOrderData.warehouseId = createdWarehouseId;
                            mappedOrderData.createdAt = new Date().toISOString();
                            results.createdOrders.push(mappedOrderData);
                            
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

            // Add processing metadata
            results.processingCompletedAt = new Date().toISOString();
            const processingTime = new Date(results.processingCompletedAt) - new Date(results.processingStartedAt);
            results.processingTimeMs = processingTime;
        }

        // Print Step 1 summary
        console.log('\n' + '='.repeat(80));
        console.log('\n📊 Step 1 Summary:');
        console.log(`   Total Orders Processed: ${results.totalOrders}`);
        console.log(`   ✅ Successfully Mapped: ${results.summary.mapped}`);
        
        if (shipstationClient) {
            console.log(`   🚀 Created in ShipStation (via /v2/shipments): ${results.summary.created}`);
            if (results.summary.creationFailed > 0) {
                console.log(`   ❌ Creation Failed: ${results.summary.creationFailed}`);
            }
        } else {
            console.log(`   ⚠️  ShipStation creation skipped (client not initialized)`);
        }
        
        const duplicateCount = results.mappedOrders.filter(o => o.shipstationSkipped === true).length;
        if (duplicateCount > 0) {
            console.log(`   🔄 Duplicates Found (already exist in ShipStation): ${duplicateCount}`);
        }
        
        if (results.processingTimeMs) {
            console.log(`   ⏱️  Processing Time: ${results.processingTimeMs}ms`);
        }
        
        if (results.lastPosition) {
            console.log(`\n   📍 Stream Position: ${results.lastPosition}`);
            console.log(`   📡 Stream ID: ${results.streamId}`);
            console.log(`\n   ℹ️  Note: Stream position is updated by rithumClient.checkForNewOrders().`);
            console.log(`      Position advances based on events retrieved from stream.`);
            console.log(`      Next run will fetch orders after position: ${results.lastPosition}`);
        }
        
        // Warn about position tracking safety (per Project.md)
        if (results.summary.creationFailed > 0) {
            console.log(`\n   ⚠️  WARNING: ${results.summary.creationFailed} order(s) failed to create in ShipStation.`);
            console.log(`      Stream position may have advanced even though some orders failed.`);
            console.log(`      Review failed orders and consider manual reprocessing if needed.`);
            console.log(`      See Project.md "Stream Position Safety" section for details.`);
        }
        
        console.log('\n💡 Step 2 (shipped orders) is handled by WEBHOOKS, not this script.');
        console.log('   Webhook endpoint: POST /api/shipstation/webhooks/v2');
        console.log('   Register webhook for "fulfillment_shipped_v2" event in ShipStation.');
        console.log('   Webhooks are more reliable and don\'t require position tracking.\n');

        // Save to output.json
        await saveOutput(results);

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
        console.log(`\n💾 Results saved to: ${OUTPUT_FILE}\n`);
    } catch (error) {
        console.error(`\n❌ Failed to save output file: ${error.message}`);
    }
}

module.exports = { fetchAndMapOrders };

if (require.main === module) {
    fetchAndMapOrders();
}

