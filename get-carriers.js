require('dotenv').config({ override: true });
const ShipStationClient = require('./src/services/shipstationClient');
const { shipstationConfig } = require('./src/config/shipstationConfig');

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
        }
        
        // Get USPS/Stamps.com carrier
        const uspsCarriers = response.data.carriers.filter(c => 
            c.name.toLowerCase().includes('stamps') || 
            c.name.toLowerCase().includes('usps') ||
            c.carrier_code.toLowerCase().includes('usps') ||
            c.carrier_code.toLowerCase().includes('stamps')
        );
        
        console.log('USPS/Stamps.com Carriers:');
        console.log('═'.repeat(30));
        uspsCarriers.forEach(carrier => {
            console.log(`${carrier.name} - ID: ${carrier.carrier_id}`);
        });
        
        return uspsCarriers.length > 0 ? uspsCarriers[0].carrier_id : null;
        
    } catch (error) {
        console.error('Error fetching carriers:', error.message);
        if (error.response?.data) {
            console.error('Response:', JSON.stringify(error.response.data, null, 2));
        }
        return null;
    }
}

getCarriers().then(carrierId => {
    console.log('\n✅ Done!');
    if (carrierId) {
        console.log(`🎯 Default USPS Carrier ID: ${carrierId}`);
    }
}).catch(console.error);