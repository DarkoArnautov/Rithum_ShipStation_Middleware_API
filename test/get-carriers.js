require('dotenv').config();
const ShipStationClient = require('../src/services/shipstationClient');
const { shipstationConfig } = require('../src/config/shipstationConfig');

async function getCarriers() {
    try {
        console.log('🚚 Fetching available carriers from ShipStation...\n');
        
        const client = new ShipStationClient(
            shipstationConfig.apiKey,
            shipstationConfig.baseUrl,
            shipstationConfig.warehouseId,
            shipstationConfig.shipFrom
        );
        
        const response = await client.client.get('/v2/carriers');
        console.log('Available Carriers:');
        console.log('═'.repeat(50));
        
        if (response.data.carriers) {
            response.data.carriers.forEach((carrier, idx) => {
                console.log(`${idx + 1}. ${carrier.name} (ID: ${carrier.carrier_id})`);
                console.log(`   Code: ${carrier.carrier_code}`);
                console.log(`   Primary: ${carrier.primary || false}`);
                console.log(`   Balance: $${carrier.balance || 'N/A'}`);
                console.log('');
            });
            
            // Find USPS/Stamps.com carriers
            const uspsCarriers = response.data.carriers.filter(c => 
                c.name.toLowerCase().includes('stamps') || 
                c.name.toLowerCase().includes('usps') ||
                c.carrier_code.toLowerCase().includes('usps') ||
                c.carrier_code.toLowerCase().includes('stamps')
            );
            
            if (uspsCarriers.length > 0) {
                console.log('USPS/Stamps.com Carriers Found:');
                console.log('═'.repeat(35));
                uspsCarriers.forEach((carrier, idx) => {
                    console.log(`${idx + 1}. ${carrier.name} - ID: ${carrier.carrier_id}`);
                    console.log(`   Code: ${carrier.carrier_code}`);
                    console.log(`   Primary: ${carrier.primary || false}`);
                    console.log(`   Balance: $${carrier.balance || 'N/A'}`);
                    console.log('');
                });
                
                // Suggest the primary one or first one
                const defaultCarrier = uspsCarriers.find(c => c.primary) || uspsCarriers[0];
                console.log(`🎯 Suggested Default Carrier: ${defaultCarrier.name}`);
                console.log(`   ID: ${defaultCarrier.carrier_id}`);
                console.log(`   Add this to your .env file as: SHIPSTATION_CARRIER_ID=${defaultCarrier.carrier_id}`);
            } else {
                console.log('⚠️  No USPS/Stamps.com carriers found');
            }
        }
        
    } catch (error) {
        console.error('❌ Error fetching carriers:', error.message);
        if (error.response?.data) {
            console.error('Response:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

getCarriers();