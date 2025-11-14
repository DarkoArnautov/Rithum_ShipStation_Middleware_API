require('dotenv').config();
const ShipStationClient = require('./src/services/shipstationClient');
const { shipstationConfig } = require('./src/config/shipstationConfig');

async function replaceWebhooks() {
    const client = new ShipStationClient(shipstationConfig.apiKey);
    
    const OLD_WEBHOOK_IDS = [38693, 38694]; // IDs to delete (current incorrect URLs)
    const NEW_URL = 'https://rithum-shipstation-middleware-api-webhook-0okw.onrender.com/webhook';
    
    console.log('\n🗑️  Step 1: Deleting old webhooks...\n');
    
    for (const id of OLD_WEBHOOK_IDS) {
        try {
            await client.deleteWebhook(id);
            console.log(`   ✅ Deleted webhook ${id}`);
        } catch (error) {
            console.log(`   ⚠️  Could not delete webhook ${id}: ${error.message}`);
        }
    }
    
    console.log('\n✅ Step 2: Creating new webhooks...\n');
    
    // Create webhook for label_created_v2
    try {
        const webhook1 = await client.createWebhook(
            'Rithum Tracking Updates - Label Created',
            'label_created_v2',
            NEW_URL
        );
        console.log(`   ✅ Created label_created_v2 webhook`);
        console.log(`      ID: ${webhook1.webhook_id}`);
        console.log(`      URL: ${NEW_URL}`);
    } catch (error) {
        console.log(`   ❌ Error creating label_created_v2: ${error.message}`);
    }
    
    // Create webhook for fulfillment_shipped_v2
    try {
        const webhook2 = await client.createWebhook(
            'Rithum Tracking Updates - Fulfillment Shipped',
            'fulfillment_shipped_v2',
            NEW_URL
        );
        console.log(`\n   ✅ Created fulfillment_shipped_v2 webhook`);
        console.log(`      ID: ${webhook2.webhook_id}`);
        console.log(`      URL: ${NEW_URL}`);
    } catch (error) {
        console.log(`   ❌ Error creating fulfillment_shipped_v2: ${error.message}`);
    }
    
    console.log('\n✅ Done! Webhooks updated.\n');
}

replaceWebhooks().catch(console.error);
