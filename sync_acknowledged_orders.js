require('dotenv').config();
const ShipStationClient = require('./src/services/shipstationClient');
const RithumClient = require('./src/services/rithumClient');
const { shipstationConfig, validateConfig: validateShipStationConfig } = require('./src/config/shipstationConfig');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

// Import functions from webhook script
const {
    updateRithumOrderTracking
} = require('./webhook_shipstation_update_Rithum');

/**
 * Get all acknowledged orders from Rithum
 */
async function getAcknowledgedOrders(rithumClient) {
    console.log('🔍 Fetching acknowledged orders from Rithum...\n');
    
    try {
        const acknowledgedOrders = [];
        const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
        const until = new Date().toISOString();
        
        let scrollId = null;
        let pageCount = 0;
        const maxPages = 50; // Limit to prevent infinite loops
        
        while (pageCount < maxPages) {
            pageCount++;
            
            const params = scrollId 
                ? { scrollId }
                : { ordersUpdatedSince: since, until: until, ordersPerPage: 100 };
            
            console.log(`   Fetching page ${pageCount}...`);
            const orderResponse = await rithumClient.makeRequest('GET', '/order/page', null, params);
            const orders = orderResponse?.orders || [];
            
            if (orders.length === 0) {
                break;
            }
            
            // Filter for acknowledged orders only
            const acknowledgedOnPage = orders.filter(o => o.dscoLifecycle === 'acknowledged');
            acknowledgedOrders.push(...acknowledgedOnPage);
            
            console.log(`      Found ${orders.length} orders (${acknowledgedOnPage.length} acknowledged)`);
            
            // Check if there are more pages
            if (orderResponse.scrollId && orderResponse.scrollId !== scrollId) {
                scrollId = orderResponse.scrollId;
            } else {
                break; // No more pages
            }
        }
        
        console.log(`\n✅ Total acknowledged orders found: ${acknowledgedOrders.length}\n`);
        return acknowledgedOrders;
        
    } catch (error) {
        console.error('❌ Error fetching acknowledged orders:', error.message);
        throw error;
    }
}

/**
 * Find shipment in ShipStation by PO number
 */
async function findShipmentByPO(poNumber, shipstationClient) {
    try {
        // Method 1: Try external_shipment_id
        try {
            const shipment = await shipstationClient.getShipmentByExternalId(poNumber);
            if (shipment && shipment.shipment_id) {
                return shipment;
            }
        } catch (error) {
            // Not found, continue to next method
        }

        // Method 2: Try shipment_number
        try {
            const response = await shipstationClient.client.get('/v2/shipments', {
                params: {
                    shipment_number: poNumber,
                    page_size: 10
                }
            });
            
            const shipments = response.data?.shipments || [];
            if (shipments.length > 0) {
                return shipments[0];
            }
        } catch (error) {
            // Not found
        }

        return null;
        
    } catch (error) {
        console.warn(`   ⚠️  Error searching for PO ${poNumber}: ${error.message}`);
        return null;
    }
}

/**
 * Check if shipment has been shipped (has label purchased)
 */
function isShipped(shipment) {
    if (!shipment) return false;
    
    // Check if status is label_purchased or has tracking number
    return shipment.shipment_status === 'label_purchased' || 
           (shipment.tracking_number && shipment.tracking_number !== '');
}

/**
 * Sync acknowledged orders from Rithum with ShipStation
 */
async function syncAcknowledgedOrders(shipstationClient, rithumClient, options = {}) {
    const {
        dryRun = false,
        maxOrders = null
    } = options;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`📋 Syncing Acknowledged Orders from Rithum`);
    console.log(`${'='.repeat(80)}`);
    if (dryRun) {
        console.log(`⚠️  DRY RUN MODE - No updates will be made to Rithum\n`);
    }
    console.log('');

    try {
        // Step 1: Get all acknowledged orders from Rithum
        const acknowledgedOrders = await getAcknowledgedOrders(rithumClient);
        
        if (acknowledgedOrders.length === 0) {
            console.log('✅ No acknowledged orders found. All orders are up to date!\n');
            return {
                success: true,
                totalChecked: 0,
                foundInShipStation: 0,
                shipped: 0,
                updated: 0,
                skipped: 0,
                notFound: 0,
                errors: 0
            };
        }

        // Limit orders if maxOrders specified
        const ordersToProcess = maxOrders 
            ? acknowledgedOrders.slice(0, maxOrders)
            : acknowledgedOrders;

        console.log(`📦 Processing ${ordersToProcess.length} acknowledged orders...\n`);

        const stats = {
            totalChecked: ordersToProcess.length,
            foundInShipStation: 0,
            shipped: 0,
            updated: 0,
            skipped: 0,
            notFound: 0,
            errors: 0
        };

        const results = [];

        // Step 2: Check each order in ShipStation
        for (let i = 0; i < ordersToProcess.length; i++) {
            const order = ordersToProcess[i];
            const poNumber = order.poNumber;
            const dscoOrderId = order.dscoOrderId;

            console.log(`\n[${i + 1}/${ordersToProcess.length}] Checking order:`);
            console.log(`   Rithum Order ID: ${dscoOrderId}`);
            console.log(`   PO Number: ${poNumber || 'N/A'}`);

            if (!poNumber) {
                console.log(`   ⏭️  SKIPPING: No PO number`);
                stats.skipped++;
                results.push({
                    dscoOrderId,
                    poNumber: null,
                    status: 'skipped',
                    reason: 'No PO number'
                });
                continue;
            }

            try {
                // Find shipment in ShipStation
                const shipment = await findShipmentByPO(poNumber, shipstationClient);

                if (!shipment) {
                    console.log(`   ⏭️  NOT FOUND in ShipStation`);
                    stats.notFound++;
                    results.push({
                        dscoOrderId,
                        poNumber,
                        status: 'not_found',
                        reason: 'Shipment not found in ShipStation'
                    });
                    continue;
                }

                stats.foundInShipStation++;
                console.log(`   ✅ Found in ShipStation: ${shipment.shipment_id}`);
                console.log(`      Status: ${shipment.shipment_status}`);

                // Check if shipped
                if (!isShipped(shipment)) {
                    console.log(`   ⏭️  NOT SHIPPED yet (no label purchased)`);
                    stats.skipped++;
                    results.push({
                        dscoOrderId,
                        poNumber,
                        shipmentId: shipment.shipment_id,
                        status: 'not_shipped',
                        reason: 'Label not purchased yet'
                    });
                    continue;
                }

                stats.shipped++;
                console.log(`   ✅ SHIPPED - Has label purchased`);

                // Get tracking info
                let trackingInfo = {
                    tracking_number: shipment.tracking_number || null,
                    carrier_id: shipment.carrier_id,
                    carrier_code: shipment.carrier_code,
                    carrier_name: shipment.carrier_name,
                    ship_date: shipment.ship_date
                };
                
                // If no tracking on shipment, try to get from label
                if (!trackingInfo.tracking_number) {
                    try {
                        const labelsResponse = await shipstationClient.client.get('/v2/labels', {
                            params: { shipment_id: shipment.shipment_id }
                        });
                        const labels = labelsResponse.data?.labels || [];
                        if (labels.length > 0) {
                            trackingInfo.tracking_number = labels[0].tracking_number;
                            trackingInfo.carrier_code = labels[0].carrier_code;
                        }
                    } catch (labelError) {
                        // Continue without tracking
                    }
                }

                console.log(`      Tracking: ${trackingInfo.tracking_number || 'N/A'}`);

                if (dryRun) {
                    console.log(`   🔍 DRY RUN: Would update Rithum order ${dscoOrderId}`);
                    stats.updated++;
                    results.push({
                        dscoOrderId,
                        poNumber,
                        shipmentId: shipment.shipment_id,
                        trackingNumber: trackingInfo.tracking_number,
                        status: 'would_update',
                        reason: 'Dry run mode'
                    });
                    continue;
                }

                // Update Rithum order
                console.log(`   📤 Updating Rithum order...`);
                const updateResult = await updateRithumOrderTracking(
                    rithumClient,
                    dscoOrderId,
                    shipment,
                    trackingInfo,
                    shipstationClient,
                    shipment.shipment_id
                );

                if (updateResult.statusResponse?.skipped) {
                    console.log(`   ⏭️  SKIPPED: ${updateResult.statusResponse.reason}`);
                    stats.skipped++;
                    results.push({
                        dscoOrderId,
                        poNumber,
                        shipmentId: shipment.shipment_id,
                        trackingNumber: updateResult.trackingNumber,
                        status: 'skipped',
                        reason: updateResult.statusResponse.reason
                    });
                } else {
                    console.log(`   ✅ UPDATED successfully`);
                    console.log(`      Request ID: ${updateResult.statusResponse?.requestId || 'N/A'}`);
                    stats.updated++;
                    results.push({
                        dscoOrderId,
                        poNumber,
                        shipmentId: shipment.shipment_id,
                        trackingNumber: updateResult.trackingNumber,
                        status: 'updated',
                        requestId: updateResult.statusResponse?.requestId
                    });
                }

            } catch (error) {
                console.error(`   ❌ ERROR: ${error.message}`);
                stats.errors++;
                results.push({
                    dscoOrderId,
                    poNumber,
                    status: 'error',
                    error: error.message
                });
            }
        }

        // Summary
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📊 Sync Summary`);
        console.log(`${'='.repeat(80)}`);
        console.log(`   Total Checked: ${stats.totalChecked}`);
        console.log(`   Found in ShipStation: ${stats.foundInShipStation}`);
        console.log(`   With Shipped Labels: ${stats.shipped}`);
        console.log(`   ✅ Updated: ${stats.updated}`);
        console.log(`   ⏭️  Skipped: ${stats.skipped}`);
        console.log(`   ❓ Not Found in ShipStation: ${stats.notFound}`);
        console.log(`   ❌ Errors: ${stats.errors}`);
        console.log(`${'='.repeat(80)}\n`);

        return {
            success: stats.errors === 0,
            ...stats,
            results
        };

    } catch (error) {
        console.error(`\n❌ Error syncing orders:`, error.message);
        throw error;
    }
}

/**
 * Main function
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║           Sync Acknowledged Orders from Rithum to ShipStation            ║
╚═══════════════════════════════════════════════════════════════════════════╝

This script automatically:
1. Fetches all "acknowledged" orders from Rithum
2. Checks each order in ShipStation by PO number
3. If the order has been shipped (label purchased), updates Rithum with tracking

Usage:
  node sync_acknowledged_orders.js [options]

Options:
  --dry-run          Show what would be updated without making changes
  --max <number>     Limit processing to first N orders (for testing)
  --help, -h         Show this help message

Examples:
  # Dry run - see what would be updated
  node sync_acknowledged_orders.js --dry-run

  # Process first 10 orders only (testing)
  node sync_acknowledged_orders.js --max 10

  # Full sync - update all acknowledged orders
  node sync_acknowledged_orders.js

Environment Variables Required:
  SHIPSTATION_API_KEY       ShipStation API key
  RITHUM_CLIENT_ID          Rithum API client ID
  RITHUM_CLIENT_SECRET      Rithum API client secret

Process:
  ✓ Fetches acknowledged orders from Rithum (last 60 days)
  ✓ Searches ShipStation by PO number
  ✓ Checks if shipment has label purchased
  ✓ Updates Rithum with tracking information
  ✓ Skips orders already completed or without labels

Notes:
  - Only processes orders in "acknowledged" lifecycle state
  - Skips orders that don't exist in ShipStation
  - Skips orders without purchased labels
  - Safe to run multiple times (checks for duplicates)
        `);
        process.exit(0);
    }

    // Parse options
    const dryRun = args.includes('--dry-run');
    const maxIndex = args.indexOf('--max');
    const maxOrders = maxIndex >= 0 ? parseInt(args[maxIndex + 1]) : null;

    try {
        // Initialize ShipStation client
        console.log('🔧 Initializing ShipStation client...');
        validateShipStationConfig();
        const shipstationClient = new ShipStationClient(
            shipstationConfig.apiKey,
            shipstationConfig.baseUrl,
            shipstationConfig.warehouseId,
            shipstationConfig.shipFrom
        );
        console.log('✅ ShipStation client initialized');

        // Initialize Rithum client
        console.log('🔧 Initializing Rithum client...');
        validateRithumConfig();
        const rithumClient = new RithumClient(
            rithumConfig.apiUrl,
            rithumConfig.clientId,
            rithumConfig.clientSecret
        );
        console.log('✅ Rithum client initialized');

        // Sync orders
        const result = await syncAcknowledgedOrders(shipstationClient, rithumClient, {
            dryRun,
            maxOrders
        });

        if (result.success && result.updated > 0) {
            console.log('✅ Sync completed successfully');
            process.exit(0);
        } else if (result.updated === 0 && result.errors === 0) {
            console.log('✅ All acknowledged orders are up to date');
            process.exit(0);
        } else {
            console.log('⚠️  Sync completed with some errors');
            process.exit(1);
        }

    } catch (error) {
        console.error('\n❌ Fatal error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = {
    syncAcknowledgedOrders,
    getAcknowledgedOrders,
    findShipmentByPO
};
