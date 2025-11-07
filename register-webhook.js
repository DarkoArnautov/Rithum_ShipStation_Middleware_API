/**
 * Register Webhook with ShipStation
 * 
 * This script registers a webhook URL with ShipStation for receiving
 * fulfillment_shipped_v2 events (or other webhook events).
 * 
 * Usage:
 *   node register-webhook.js                                    # Register with default settings
 *   WEBHOOK_URL=https://your-domain.com/api/shipstation/webhooks/v2 node register-webhook.js
 *   node register-webhook.js --list                             # List existing webhooks
 *   node register-webhook.js --delete <webhook_id>              # Delete a webhook
 * 
 * Prerequisites:
 *   1. Your webhook endpoint must be publicly accessible (use ngrok for local testing)
 *   2. ShipStation API credentials must be configured in .env
 * 
 * Example with ngrok:
 *   1. Start your webhook server: node webhook_step2.js
 *   2. In another terminal, start ngrok: ngrok http 8000
 *   3. Copy the ngrok URL (e.g., https://abc123.ngrok.io)
 *   4. Run: WEBHOOK_URL=https://abc123.ngrok.io/api/shipstation/webhooks/v2 node register-webhook.js
 */

require('dotenv').config();
const ShipStationClient = require('./src/services/shipstationClient');
const { shipstationConfig, validateConfig } = require('./src/config/shipstationConfig');

// Default webhook configuration
const DEFAULT_WEBHOOK_NAME = 'Rithum Tracking Updates';
const DEFAULT_WEBHOOK_EVENT = 'fulfillment_shipped_v2';
const DEFAULT_WEBHOOK_URL = process.env.WEBHOOK_URL || process.env.API_URL || 'http://localhost:8000/api/shipstation/webhooks/v2';

async function listWebhooks(client) {
    try {
        console.log('\n📋 Listing existing webhooks...\n');
        const webhooks = await client.listWebhooks();
        
        if (webhooks.length === 0) {
            console.log('   No webhooks found.\n');
            return;
        }

        console.log(`   Found ${webhooks.length} webhook(s):\n`);
        webhooks.forEach((webhook, index) => {
            console.log(`   ${index + 1}. ${webhook.name || 'Unnamed'}`);
            console.log(`      ID: ${webhook.webhook_id}`);
            console.log(`      Event: ${webhook.event}`);
            console.log(`      URL: ${webhook.url}`);
            console.log(`      Active: ${webhook.active !== false ? 'Yes' : 'No'}`);
            console.log('');
        });
    } catch (error) {
        console.error('❌ Error listing webhooks:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Response:', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

async function registerWebhook(client, name, event, url) {
    try {
        console.log('\n📝 Registering webhook with ShipStation...\n');
        console.log('   Configuration:');
        console.log(`   Name: ${name}`);
        console.log(`   Event: ${event}`);
        console.log(`   URL: ${url}\n`);

        // Check if webhook already exists for this event
        const existingWebhooks = await client.listWebhooks();
        const existingWebhook = existingWebhooks.find(
            wh => wh.event === event && wh.url === url
        );

        if (existingWebhook) {
            console.log(`⚠️  Webhook already exists for event "${event}" with this URL.`);
            console.log(`   Webhook ID: ${existingWebhook.webhook_id}`);
            console.log(`   Would you like to update it instead? (Use --update <webhook_id>)\n`);
            return existingWebhook;
        }

        const webhook = await client.createWebhook(name, event, url);
        
        console.log('✅ Webhook registered successfully!\n');
        console.log('   Webhook Details:');
        console.log(`   ID: ${webhook.webhook_id}`);
        console.log(`   Name: ${webhook.name || name}`);
        console.log(`   Event: ${webhook.event || event}`);
        console.log(`   URL: ${webhook.url || url}`);
        console.log(`   Active: ${webhook.active !== false ? 'Yes' : 'No'}\n`);
        
        return webhook;
    } catch (error) {
        console.error('❌ Error registering webhook:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Response:', JSON.stringify(error.response.data, null, 2));
            
            if (error.response.status === 409) {
                console.error('\n   💡 This webhook may already exist. Try listing webhooks with --list');
            }
        }
        throw error;
    }
}

async function deleteWebhook(client, webhookId) {
    try {
        console.log(`\n🗑️  Deleting webhook ${webhookId}...\n`);
        await client.deleteWebhook(webhookId);
        console.log(`✅ Webhook ${webhookId} deleted successfully!\n`);
    } catch (error) {
        console.error('❌ Error deleting webhook:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Response:', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

async function updateWebhook(client, webhookId, url) {
    try {
        console.log(`\n🔄 Updating webhook ${webhookId}...\n`);
        console.log(`   New URL: ${url}\n`);
        const webhook = await client.updateWebhook(webhookId, url);
        console.log('✅ Webhook updated successfully!\n');
        console.log('   Updated Webhook:');
        console.log(`   ID: ${webhook.webhook_id}`);
        console.log(`   URL: ${webhook.url}\n`);
        return webhook;
    } catch (error) {
        console.error('❌ Error updating webhook:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Response:', JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

async function main() {
    console.log('='.repeat(80));
    console.log('🔗 ShipStation Webhook Registration');
    console.log('='.repeat(80));

    // Parse command line arguments
    const args = process.argv.slice(2);
    const command = args[0];

    // Validate configuration
    try {
        validateConfig();
    } catch (error) {
        console.error('❌ ShipStation configuration error:', error.message);
        console.error('   Please ensure SHIPSTATION_API_KEY is set in .env file');
        process.exit(1);
    }

    // Initialize ShipStation client
    let client;
    try {
        client = new ShipStationClient(
            shipstationConfig.apiKey,
            shipstationConfig.baseUrl,
            shipstationConfig.warehouseId,
            shipstationConfig.shipFrom
        );
        console.log('✅ ShipStation client initialized\n');
    } catch (error) {
        console.error('❌ Failed to initialize ShipStation client:', error.message);
        process.exit(1);
    }

    try {
        if (command === '--list' || command === '-l') {
            // List existing webhooks
            await listWebhooks(client);
        } else if (command === '--delete' || command === '-d') {
            // Delete webhook
            const webhookId = args[1];
            if (!webhookId) {
                console.error('❌ Please provide a webhook ID to delete');
                console.error('   Usage: node register-webhook.js --delete <webhook_id>');
                process.exit(1);
            }
            await deleteWebhook(client, webhookId);
        } else if (command === '--update' || command === '-u') {
            // Update webhook URL
            const webhookId = args[1];
            const newUrl = args[2] || DEFAULT_WEBHOOK_URL;
            if (!webhookId) {
                console.error('❌ Please provide a webhook ID to update');
                console.error('   Usage: node register-webhook.js --update <webhook_id> [new_url]');
                process.exit(1);
            }
            await updateWebhook(client, webhookId, newUrl);
        } else {
            // Register new webhook (default action)
            const webhookUrl = process.env.WEBHOOK_URL || DEFAULT_WEBHOOK_URL;
            const webhookName = process.env.WEBHOOK_NAME || DEFAULT_WEBHOOK_NAME;
            const webhookEvent = process.env.WEBHOOK_EVENT || DEFAULT_WEBHOOK_EVENT;

            // Validate URL
            if (webhookUrl.includes('localhost') && !webhookUrl.includes('ngrok')) {
                console.log('⚠️  WARNING: Using localhost URL. This will not work from ShipStation!');
                console.log('   For local testing, use ngrok:');
                console.log('   1. Start your webhook server: node webhook_step2.js');
                console.log('   2. In another terminal: ngrok http 8000');
                console.log('   3. Copy the ngrok URL and run:');
                console.log(`      WEBHOOK_URL=https://your-ngrok-url.ngrok.io/api/shipstation/webhooks/v2 node register-webhook.js\n`);
            }

            await registerWebhook(client, webhookName, webhookEvent, webhookUrl);
            
            console.log('💡 Next Steps:');
            console.log('   1. Make sure your webhook server is running: node webhook_step2.js');
            console.log('   2. Ship an order in ShipStation to test');
            console.log('   3. Check webhook_step2.js logs for received events\n');
        }
    } catch (error) {
        console.error('\n❌ Operation failed:', error.message);
        process.exit(1);
    }
}

// Run the script
if (require.main === module) {
    main();
}

module.exports = { registerWebhook, listWebhooks, deleteWebhook, updateWebhook };

