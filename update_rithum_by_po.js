require('dotenv').config();
const ShipStationClient = require('./src/services/shipstationClient');
const RithumClient = require('./src/services/rithumClient');
const { shipstationConfig, validateConfig: validateShipStationConfig } = require('./src/config/shipstationConfig');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

// Import functions from the batch script
const {
    updateRithumOrderTracking,
    extractRithumOrderId
} = require('./update_rithum_from_batch');

/**
 * Find and update a single order by PO number
 */
async function updateOrderByPO(poNumber, shipstationClient, rithumClient) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔍 Searching for Order with PO Number: ${poNumber}`);
    console.log(`${'='.repeat(80)}\n`);

    try {
        // Method 1: Try to find shipment by external_shipment_id (usually matches PO number)
        console.log(`📋 Method 1: Searching by external_shipment_id...`);
        let shipment = null;
        
        try {
            shipment = await shipstationClient.getShipmentByExternalId(poNumber);
            if (shipment && shipment.shipment_id) {
                console.log(`✅ Found shipment by external_shipment_id: ${shipment.shipment_id}`);
            }
        } catch (error) {
            if (error.response?.status !== 404) {
                console.warn(`   ⚠️  Error searching by external_shipment_id: ${error.message}`);
            }
        }

        // Method 2: Try to find by shipment_number
        if (!shipment) {
            console.log(`📋 Method 2: Searching by shipment_number...`);
            try {
                const response = await shipstationClient.client.get('/v2/shipments', {
                    params: {
                        shipment_number: poNumber,
                        page_size: 10
                    }
                });
                
                const shipments = response.data?.shipments || [];
                if (shipments.length > 0) {
                    shipment = shipments[0];
                    console.log(`✅ Found shipment by shipment_number: ${shipment.shipment_id}`);
                }
            } catch (error) {
                console.warn(`   ⚠️  Error searching by shipment_number: ${error.message}`);
            }
        }

        // Method 3: Search recent shipments and match
        if (!shipment) {
            console.log(`📋 Method 3: Searching recent shipments...`);
            try {
                // Search last 30 days
                const endDate = new Date();
                const startDate = new Date();
                startDate.setDate(startDate.getDate() - 30);
                
                const response = await shipstationClient.client.get('/v2/shipments', {
                    params: {
                        created_at_start: startDate.toISOString(),
                        created_at_end: endDate.toISOString(),
                        page_size: 500
                    }
                });
                
                const shipments = response.data?.shipments || [];
                console.log(`   Found ${shipments.length} shipments in last 30 days`);
                
                // Search for matching PO number
                shipment = shipments.find(s => 
                    s.external_shipment_id === poNumber ||
                    s.shipment_number === poNumber ||
                    (s.tags && s.tags.some(tag => tag.name === poNumber))
                );
                
                if (shipment) {
                    console.log(`✅ Found shipment in recent orders: ${shipment.shipment_id}`);
                }
            } catch (error) {
                console.warn(`   ⚠️  Error searching recent shipments: ${error.message}`);
            }
        }

        if (!shipment) {
            console.log(`\n❌ No shipment found for PO Number: ${poNumber}`);
            console.log(`\n💡 Tips:`);
            console.log(`   - Verify the PO number is correct`);
            console.log(`   - Check if the order exists in ShipStation`);
            console.log(`   - The order might be older than 30 days\n`);
            return {
                success: false,
                poNumber,
                message: 'Shipment not found'
            };
        }

        // Display shipment info
        console.log(`\n📦 Shipment Details:`);
        console.log(`   Shipment ID: ${shipment.shipment_id}`);
        console.log(`   Shipment Number: ${shipment.shipment_number}`);
        console.log(`   External ID: ${shipment.external_shipment_id || 'N/A'}`);
        console.log(`   Status: ${shipment.shipment_status}`);
        console.log(`   Created: ${shipment.created_at}`);
        console.log(`   Tracking: ${shipment.tracking_number || 'N/A'}`);

        // Check if shipment has a label (is shipped)
        if (shipment.shipment_status !== 'label_purchased' && !shipment.tracking_number) {
            console.log(`\n⚠️  WARNING: Shipment does not have a purchased label yet`);
            console.log(`   Status: ${shipment.shipment_status}`);
            console.log(`   You may need to purchase a label first in ShipStation\n`);
            
            const readline = require('readline').createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            const answer = await new Promise(resolve => {
                readline.question('Continue anyway? (y/n): ', resolve);
            });
            readline.close();
            
            if (answer.toLowerCase() !== 'y') {
                console.log('Operation cancelled by user\n');
                return {
                    success: false,
                    poNumber,
                    message: 'Cancelled - no label purchased'
                };
            }
        }

        // Extract Rithum order ID
        console.log(`\n🔍 Extracting Rithum Order ID...`);
        const rithumOrderId = await extractRithumOrderId(shipment, shipstationClient);

        if (!rithumOrderId) {
            console.log(`\n❌ Could not find Rithum Order ID`);
            console.log(`   This shipment may not have been created through the middleware`);
            console.log(`   Or the Rithum Order ID was not stored in tags/external_shipment_id\n`);
            return {
                success: false,
                poNumber,
                shipmentId: shipment.shipment_id,
                message: 'Rithum Order ID not found'
            };
        }

        console.log(`✅ Rithum Order ID: ${rithumOrderId}`);

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
                console.log(`\n🔍 Fetching label for tracking information...`);
                const labelsResponse = await shipstationClient.client.get('/v2/labels', {
                    params: { shipment_id: shipment.shipment_id }
                });
                const labels = labelsResponse.data?.labels || [];
                if (labels.length > 0) {
                    trackingInfo.tracking_number = labels[0].tracking_number;
                    trackingInfo.carrier_code = labels[0].carrier_code;
                    trackingInfo.carrier_name = labels[0].carrier_code;
                    console.log(`   ✅ Found tracking: ${trackingInfo.tracking_number}`);
                }
            } catch (labelError) {
                console.warn(`   ⚠️  Could not fetch label: ${labelError.message}`);
            }
        }

        // Update Rithum order
        console.log(`\n📤 Updating Rithum Order...`);
        const updateResult = await updateRithumOrderTracking(
            rithumClient,
            rithumOrderId,
            shipment,
            trackingInfo,
            shipstationClient,
            shipment.shipment_id
        );

        if (updateResult.statusResponse?.skipped) {
            console.log(`\n⏭️  Order was skipped: ${updateResult.statusResponse.reason}`);
            return {
                success: false,
                skipped: true,
                poNumber,
                shipmentId: shipment.shipment_id,
                rithumOrderId,
                trackingNumber: updateResult.trackingNumber,
                reason: updateResult.statusResponse.reason
            };
        }

        console.log(`\n${'='.repeat(80)}`);
        console.log(`✅ Successfully Updated Rithum Order`);
        console.log(`${'='.repeat(80)}`);
        console.log(`   PO Number: ${poNumber}`);
        console.log(`   Shipment ID: ${shipment.shipment_id}`);
        console.log(`   Rithum Order ID: ${rithumOrderId}`);
        console.log(`   Tracking Number: ${updateResult.trackingNumber || 'N/A'}`);
        console.log(`   Carrier: ${updateResult.carrier || 'N/A'}`);
        console.log(`   Line Items: ${updateResult.lineItemCount}`);
        if (updateResult.statusResponse?.requestId) {
            console.log(`   Rithum Request ID: ${updateResult.statusResponse.requestId}`);
        }
        console.log(`${'='.repeat(80)}\n`);

        return {
            success: true,
            poNumber,
            shipmentId: shipment.shipment_id,
            rithumOrderId,
            trackingNumber: updateResult.trackingNumber,
            carrier: updateResult.carrier,
            lineItemCount: updateResult.lineItemCount,
            requestId: updateResult.statusResponse?.requestId
        };

    } catch (error) {
        console.error(`\n❌ Error updating order with PO ${poNumber}:`, error.message);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Response:`, JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

/**
 * Main function
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.log(`
╔═══════════════════════════════════════════════════════════════════════════╗
║            Update Rithum Order by PO Number (Individual Order)           ║
╚═══════════════════════════════════════════════════════════════════════════╝

This script finds a specific ShipStation shipment by PO number and updates
the corresponding Rithum order with tracking information.

Usage:
  node update_rithum_by_po.js <po_number>

Arguments:
  po_number    Purchase Order number (PO number) from Rithum
               This is usually stored as shipment_number or external_shipment_id

Examples:
  # Update order with PO number 108819
  node update_rithum_by_po.js 108819

  # Update order with alphanumeric PO
  node update_rithum_by_po.js BOX.75880256.69983647

  # Update order with Rithum order ID
  node update_rithum_by_po.js 1032098455

Environment Variables Required:
  SHIPSTATION_API_KEY       ShipStation API key
  RITHUM_CLIENT_ID          Rithum API client ID
  RITHUM_CLIENT_SECRET      Rithum API client secret

Search Methods:
  1. Searches by external_shipment_id (exact match)
  2. Searches by shipment_number (exact match)
  3. Searches recent shipments (last 30 days) for matching PO

Notes:
  - The shipment must have a purchased label (tracking number)
  - The shipment must have a Rithum Order ID stored in tags or external_shipment_id
  - Orders already completed or with duplicate tracking will be skipped
  - You can update multiple orders by running the script multiple times
        `);
        process.exit(0);
    }

    const poNumber = args[0];

    if (!poNumber || poNumber.trim() === '') {
        console.error('❌ Error: PO number is required');
        console.error('Usage: node update_rithum_by_po.js <po_number>');
        process.exit(1);
    }

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

        // Update the order
        const result = await updateOrderByPO(poNumber, shipstationClient, rithumClient);

        if (result.success) {
            console.log('✅ Operation completed successfully');
            process.exit(0);
        } else if (result.skipped) {
            console.log('⚠️  Order was skipped (already updated or invalid state)');
            process.exit(0);
        } else {
            console.log('❌ Operation failed');
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
    updateOrderByPO
};
