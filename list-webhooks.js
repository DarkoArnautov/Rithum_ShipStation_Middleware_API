require('dotenv').config();
const ShipStationClient = require('./src/services/shipstationClient');
const { shipstationConfig } = require('./src/config/shipstationConfig');

async function manageWebhooks() {
    const client = new ShipStationClient(shipstationConfig.apiKey);
    
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
    
    return webhooks;
}

manageWebhooks().catch(console.error);
