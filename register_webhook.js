/**
 * Register Webhook in ShipStation
 * 
 * This script registers a webhook in your ShipStation account to send
 * fulfillment_shipped_v2 events to your middleware webhook endpoint.
 * 
 * Usage:
 *   node register_webhook.js
 * 
 * Or specify custom values:
 *   WEBHOOK_URL=https://your-domain.com/api/shipstation/webhooks/v2 node register_webhook.js
 */
require('dotenv').config();
const ShipStationClient = require('./src/services/shipstationClient');
const { shipstationConfig, validateConfig } = require('./src/config/shipstationConfig');

const WEBHOOK_NAME = process.env.WEBHOOK_NAME || 'Rithum Tracking Updates';
const WEBHOOK_EVENT = process.env.WEBHOOK_EVENT || 'fulfillment_shipped_v2';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:8000/api/shipstation/webhooks/v2';

async function registerWebhook() {
    try {
        console.log('📦 Registering Webhook in ShipStation\n');
        console.log('='.repeat(80) + '\n');

        // Validate configuration
        validateConfig();

        // Initialize ShipStation client
        const shipstationClient = new ShipStationClient(
            shipstationConfig.apiKey,
            shipstationConfig.baseUrl,
            shipstationConfig.warehouseId,
            shipstationConfig.shipFrom
        );

        console.log('✅ ShipStation client initialized\n');
        console.log('📋 Webhook Configuration:');
        console.log(`   Name: ${WEBHOOK_NAME}`);
        console.log(`   Event: ${WEBHOOK_EVENT}`);
        console.log(`   URL: ${WEBHOOK_URL}\n`);

        // Check if webhook already exists
        console.log('🔍 Checking existing webhooks...\n');
        try {
            const existingWebhooks = await shipstationClient.listWebhooks();
            const existing = existingWebhooks.find(w => 
                w.event === WEBHOOK_EVENT && w.url === WEBHOOK_URL
            );

            if (existing) {
                console.log(`⚠️  Webhook already exists with ID: ${existing.webhook_id}`);
                console.log(`   Event: ${existing.event}`);
                console.log(`   URL: ${existing.url}`);
                console.log(`   Status: ${existing.active ? 'Active' : 'Inactive'}\n`);
                console.log('✅ Webhook is already registered. No action needed.\n');
                return;
            }
        } catch (error) {
            console.log('   Could not check existing webhooks (will proceed to create)\n');
        }

        // Create webhook
        console.log('🚀 Creating webhook in ShipStation...\n');
        const webhook = await shipstationClient.createWebhook(
            WEBHOOK_NAME,
            WEBHOOK_EVENT,
            WEBHOOK_URL
        );

        console.log('='.repeat(80) + '\n');
        console.log('✅ Webhook successfully registered!\n');
        console.log('📋 Webhook Details:');
        console.log(`   Webhook ID: ${webhook.webhook_id}`);
        console.log(`   Name: ${webhook.name}`);
        console.log(`   Event: ${webhook.event}`);
        console.log(`   URL: ${webhook.url}`);
        console.log(`   Status: ${webhook.active ? 'Active ✅' : 'Inactive ⚠️'}\n`);
        console.log('='.repeat(80) + '\n');

        console.log('💡 Next Steps:');
        console.log('   1. Make sure your webhook server is running:');
        console.log('      node webhook_step2.js');
        console.log('   2. Or start your main server:');
        console.log('      npm start');
        console.log('   3. Ensure your webhook URL is publicly accessible');
        console.log('      (Use ngrok or deploy to a public server for testing)\n');

    } catch (error) {
        console.error('\n❌ Error registering webhook:', error.message);
        if (error.response) {
            console.error('   API Status:', error.response.status);
            console.error('   API Response:', JSON.stringify(error.response.data, null, 2));
        }
        console.error('\n💡 Troubleshooting:');
        console.error('   1. Check your ShipStation API credentials in .env');
        console.error('   2. Verify the webhook URL is valid and accessible');
        console.error('   3. Ensure the event type is supported: fulfillment_shipped_v2\n');
        process.exit(1);
    }
}

// Run
registerWebhook();
