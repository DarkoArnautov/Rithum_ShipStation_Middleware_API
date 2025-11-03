/**
 * Script to fetch new orders, map them to ShipStation format, and save to output.json
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const OrderMapper = require('./src/services/orderMapper');

const BASE_URL = process.env.API_URL || 'http://localhost:8000';
const OUTPUT_FILE = path.join(__dirname, 'output.json');

async function fetchAndMapOrders() {
    try {
        console.log('📦 Fetching new orders and mapping to ShipStation format...\n');

        // Fetch new orders with details
        const response = await axios.get(`${BASE_URL}/api/rithum/stream/new-orders`, {
            params: {
                includeDetails: true,
                showAllEvents: false
            },
            timeout: 60000
        });

        if (!response.data.success) {
            console.error('❌ Failed to fetch orders:', response.data.message);
            process.exit(1);
        }

        const { orders, newOrderCount, newOrderIds } = response.data;

        console.log(`✅ Found ${newOrderCount} new order(s)`);
        console.log(`📋 Order IDs: ${newOrderIds.length > 0 ? newOrderIds.slice(0, 5).join(', ') + (newOrderIds.length > 5 ? `... (+${newOrderIds.length - 5} more)` : '') : 'None'}\n`);

        if (!orders || orders.length === 0) {
            console.log('ℹ️  No orders to map.');
            await saveOutput({
                timestamp: new Date().toISOString(),
                totalOrders: 0,
                mappedOrders: [],
                errors: []
            });
            return;
        }

        // Initialize mapper
        const mapper = new OrderMapper();
        const results = {
            timestamp: new Date().toISOString(),
            totalOrders: orders.length,
            mappedOrders: [],
            errors: [],
            summary: {
                successful: 0,
                failed: 0,
                skipped: 0
            }
        };

        console.log('🔄 Mapping orders to ShipStation format...\n');

        // Process each order
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
                results.summary.successful++;
                results.mappedOrders.push({
                    rithumOrderId: orderId,
                    poNumber: order.poNumber,
                    originalOrder: order,
                    shipstationOrder: mappingResult.mappedOrder,
                    mappedAt: new Date().toISOString()
                });
                
                console.log(`✅ Order ${i + 1}/${orders.length} (${orderId}): Mapped successfully`);
                console.log(`   PO Number: ${mappingResult.mappedOrder.orderNumber}`);
                console.log(`   Status: ${mappingResult.mappedOrder.orderStatus}`);
                console.log(`   Items: ${mappingResult.mappedOrder.items.length}`);
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
        results.lastPosition = response.data.lastPosition;
        results.streamId = response.data.streamId;

        // Save to output.json
        await saveOutput(results);

        // Print summary
        console.log('\n' + '='.repeat(80));
        console.log('\n📊 Summary:');
        console.log(`   Total Orders: ${results.totalOrders}`);
        console.log(`   ✅ Successfully Mapped: ${results.summary.successful}`);
        console.log(`   ❌ Failed: ${results.summary.failed}`);
        console.log(`   ⏭️  Skipped: ${results.summary.skipped}`);
        console.log(`   📍 Last Position: ${response.data.lastPosition}`);
        console.log(`\n💾 Results saved to: ${OUTPUT_FILE}\n`);
        
        if (response.data.lastPosition) {
            console.log(`ℹ️  Note: Stream position has been updated to prevent re-processing these orders.`);
            console.log(`   Next run will fetch orders after position: ${response.data.lastPosition}\n`);
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

