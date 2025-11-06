/**
 * Step 1 Cron Job: Fetch new orders from Rithum and create them in ShipStation
 * 
 * This script implements Step 1 of the Rithum-ShipStation integration:
 * - Fetches new orders from Rithum using Event Streams (uses .stream-config.json for position tracking)
 * - Maps Rithum orders to ShipStation v2 format (using OrderMapper)
 * - Creates orders in ShipStation via /v2/shipments endpoint with create_sales_order: true
 * - Saves results to output.json
 * 
 * Architecture (per Project.md):
 * - Step 1: Rithum → Middleware (Cron Job) → ShipStation ✅ This script
 * - Step 2: ShipStation → Middleware (Webhook) → Rithum (NOT this script, use webhooks!)
 * 
 * Flow (Step 1):
 *   1. Event Stream: Creates/uses stream that captures order events
 *   2. Cron Job: Polls the stream for new orders (default: every 1 hour)
 *   3. Filter: Identifies 'create' events (new orders)
 *   4. Fetch Details: Gets full order information from Rithum (from event payloads)
 *   5. Map & Send: Converts format and sends to ShipStation
 *   6. Position Tracking: Stream position saved to .stream-config.json to avoid duplicates
 * 
 * Usage:
 *   node cronjob_step1.js                    # Run Step 1 (default for cron)
 * 
 * Cron Setup:
 *   # Run every hour at minute 0 (recommended)
 *   0 * * * * cd /path/to/project && node cronjob_step1.js
 * 
 *   # Run every 30 minutes
 *   0,30 * * * * cd /path/to/project && node cronjob_step1.js
 * 
 * Important Notes:
 * - Step 2 (shipped orders) should be handled by WEBHOOKS, not this script
 * - Webhook endpoint: POST /api/shipstation/webhooks/v2
 * - Register webhook for "fulfillment_shipped_v2" event in ShipStation
 * - Position tracking is handled by rithumClient.checkForNewOrders()
 * - For bulk orders (300+), consider implementing batching (see Project.md Error Handling section)
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
    console.log(`\n🔄 [${new Date().toISOString()}] fetchAndMapOrders() called - Starting order fetch and mapping process...\n`);
    try {
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
        let shipFromAddress = null;
        let warehouseId = null;
        
        try {
            validateShipStationConfig();
            shipstationClient = new ShipStationClient(
                shipstationConfig.apiKey,
                shipstationConfig.baseUrl,
                shipstationConfig.warehouseId,
                shipstationConfig.shipFrom
            );
            console.log('✅ ShipStation client initialized\n');
            
            // Fetch ship_from address from ShipStation warehouses API if not already configured
            if (!shipstationConfig.shipFrom && !shipstationConfig.warehouseId) {
                console.log('📦 Fetching warehouses from ShipStation to get ship_from address...\n');
                try {
                    const warehouses = await shipstationClient.getWarehouses();
                    console.log(`   Found ${warehouses ? warehouses.length : 0} warehouse(s) in ShipStation`);
                    
                    if (warehouses && warehouses.length > 0) {
                        // Use the default warehouse if available, otherwise use the first one
                        const defaultWarehouse = warehouses.find(w => w.is_default === true);
                        const warehouse = defaultWarehouse || warehouses[0];
                        
                        console.log(`   Using warehouse: ${warehouse.name || warehouse.warehouse_id || 'Unknown'}`);
                        if (warehouse.is_default) {
                            console.log(`   (This is the default warehouse)`);
                        }
                        
                        warehouseId = warehouse.warehouse_id;
                        
                        // Extract ship_from from warehouse origin_address (per OpenAPI spec)
                        if (warehouse.origin_address) {
                            const originAddr = warehouse.origin_address;
                            // Convert address format to ship_from format (v2 API format)
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
                            console.log(`   Location: ${shipFromAddress.city_locality || 'N/A'}, ${shipFromAddress.state_province || 'N/A'}\n`);
                        } else {
                            console.log(`⚠️  Warehouse ${warehouseId} found but no origin_address available.`);
                            console.log(`   Will use warehouse_id for order creation.\n`);
                        }
                    } else {
                        console.log('⚠️  No warehouses found in ShipStation.');
                        console.log('   You can still create orders using ship_from address.');
                        console.log('   Please configure SHIPSTATION_SHIP_FROM_* environment variables in .env file.');
                        console.log('   Example:');
                        console.log('     SHIPSTATION_SHIP_FROM_NAME=Your Company');
                        console.log('     SHIPSTATION_SHIP_FROM_ADDRESS=123 Main St');
                        console.log('     SHIPSTATION_SHIP_FROM_CITY=City');
                        console.log('     SHIPSTATION_SHIP_FROM_STATE=CA');
                        console.log('     SHIPSTATION_SHIP_FROM_POSTAL=12345');
                        console.log('     SHIPSTATION_SHIP_FROM_COUNTRY=US');
                        console.log('     SHIPSTATION_SHIP_FROM_PHONE=555-555-5555\n');
                    }
                } catch (warehouseError) {
                    console.warn(`⚠️  Could not fetch warehouses: ${warehouseError.message}`);
                    if (warehouseError.response) {
                        console.warn(`   API Status: ${warehouseError.response.status}`);
                        console.warn(`   API Response:`, JSON.stringify(warehouseError.response.data, null, 2));
                    }
                    console.warn('   Will proceed without ship_from address. Orders may fail if warehouse is not configured.\n');
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
            console.error('⚠️  Will map orders but not create them in ShipStation.\n');
        }

        // Step 1: Fetch new orders from Rithum Event Stream
        console.log('📥 Fetching new orders from Rithum Event Stream...\n');
        const rithumResponse = await rithumClient.checkForNewOrders(true); // includeOrderDetails = true

        if (!rithumResponse.success) {
            console.error('❌ Failed to fetch orders from Rithum:', rithumResponse.error || 'Unknown error');
            console.error('⚠️  Check Rithum API connectivity and stream configuration.');
            process.exit(1);
        }

        const orders = rithumResponse.orderDetails || [];
        const newOrderCount = rithumResponse.newOrderCount || 0;
        const newOrderIds = rithumResponse.newOrderIds || [];
        const allEvents = rithumResponse.allEvents || [];

        console.log(`✅ Found ${newOrderCount} new order event(s) from Rithum Stream`);
        console.log(`📋 Order IDs: ${newOrderIds.length > 0 ? newOrderIds.slice(0, 5).join(', ') + (newOrderIds.length > 5 ? `... (+${newOrderIds.length - 5} more)` : '') : 'None'}`);
        console.log(`📊 Total events processed: ${allEvents.length}`);
        console.log(`📍 Current stream position: ${rithumResponse.lastPosition || 'N/A'}\n`);

        // Warn about bulk orders (per Project.md Error Handling section)
        if (newOrderCount > 50) {
            console.log('⚠️  WARNING: Large number of orders detected (>50).');
            console.log('   Consider implementing batching for bulk order scenarios (see Project.md).');
            console.log('   Current implementation processes all orders in parallel.\n');
        }

        if (!orders || orders.length === 0) {
            console.log('ℹ️  No new orders to process.');
            console.log('   Stream position will be updated to prevent re-processing.\n');
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

        // Process orders: Map and Create in ShipStation
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
                    console.log(`   PO Number: ${mappingResult.mappedOrder.orderNumber}`);
                    console.log(`   Status: ${mappingResult.mappedOrder.orderStatus}`);
                    console.log(`   Items: ${mappingResult.mappedOrder.items.length}`);

                    // Create order in ShipStation
                    if (shipstationClient) {
                        try {
                            console.log(`   🚀 Creating order in ShipStation via /v2/shipments endpoint...`);
                            console.log(`      (Using create_sales_order: true to create order)`);
                            
                            // Add ship_from or warehouse_id to the order if we have it
                            // Note: ship_from address is sufficient - warehouse_id is optional
                            const orderWithShipFrom = { ...mappingResult.mappedOrder };
                            if (shipFromAddress) {
                                orderWithShipFrom.shipFrom = shipFromAddress;
                                console.log(`      📍 Using ship_from address for order creation (no warehouse needed)`);
                            } else if (warehouseId) {
                                orderWithShipFrom.warehouse_id = warehouseId;
                                console.log(`      📦 Using warehouse_id: ${warehouseId} for order creation`);
                            } else {
                                console.log(`      ⚠️  No ship_from address or warehouse_id available - order may fail`);
                            }
                            
                            const createdOrder = await shipstationClient.createOrder(orderWithShipFrom);
                            
                            // Get ship_from address from creation response (for logging/verification)
                            let createdShipFrom = createdOrder.ship_from || null;
                            let createdWarehouseId = createdOrder.warehouse_id || null;
                            
                            // Priority 1: Check if ship_from is in the creation response
                            if (createdShipFrom) {
                                console.log(`   📍 Ship From address from creation response`);
                            } else if (createdWarehouseId) {
                                console.log(`   📦 Warehouse ID from creation response: ${createdWarehouseId}`);
                            }
                            
                            // Priority 2: Check if we sent ship_from (fallback reference)
                            if (!createdShipFrom && !createdWarehouseId && createdOrder.sent_ship_from) {
                                createdShipFrom = createdOrder.sent_ship_from;
                                console.log(`   📍 Ship From address from sent data (fallback)`);
                            }
                            
                            // Priority 3: Fetch full shipment details if still missing
                            if (!createdShipFrom && !createdWarehouseId && createdOrder.shipment_id) {
                                try {
                                    console.log(`   🔍 Fetching full shipment details to get ship_from address...`);
                                    const shipmentResponse = await shipstationClient.client.get(`/v2/shipments/${createdOrder.shipment_id}`);
                                    const shipment = shipmentResponse.data;
                                    if (shipment.ship_from) {
                                        createdShipFrom = shipment.ship_from;
                                        console.log(`   ✅ Ship From address retrieved from GET /v2/shipments/${createdOrder.shipment_id}`);
                                    }
                                    if (shipment.warehouse_id) {
                                        createdWarehouseId = shipment.warehouse_id;
                                    }
                                } catch (detailError) {
                                    console.log(`   ⚠️  Could not retrieve shipment details: ${detailError.message}`);
                                }
                            }
                            
                            // Use the ship_from we fetched at startup if not in response
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
                            
                            console.log(`   ✅ Order created in ShipStation:`);
                            console.log(`      Sales Order ID: ${mappedOrderData.shipstationOrderId}`);
                            console.log(`      Shipment ID: ${mappedOrderData.shipstationShipmentId}`);
                            if (createdShipFrom) {
                                console.log(`      Ship From: ${createdShipFrom.company_name || createdShipFrom.name || 'N/A'}, ${createdShipFrom.city_locality || 'N/A'}, ${createdShipFrom.state_province || 'N/A'}`);
                            } else if (createdWarehouseId) {
                                console.log(`      Warehouse ID: ${createdWarehouseId}`);
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
        
        console.log(`   ❌ Mapping Failed: ${results.summary.failed}`);
        console.log(`   ⏭️  Skipped: ${results.summary.skipped}`);
        
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
        // Don't throw - allow script to continue even if save fails
    }
}

// Export the function for use in scheduled versions
module.exports = { fetchAndMapOrders };

// Run the script if called directly (not imported)
if (require.main === module) {
    fetchAndMapOrders();
}

