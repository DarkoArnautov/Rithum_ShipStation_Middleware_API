/**
 * Carrier Selection Service
 * Intelligently selects the appropriate carrier for shipments based on various factors
 * Now includes Rithum carrier requirement integration
 */

const RithumCarrierMapper = require('./rithumCarrierMapper');

class CarrierSelector {
    constructor(shipstationClient) {
        this.shipstationClient = shipstationClient;
        this.carriersCache = null;
        this.cacheExpiry = null;
        this.CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
        this.rithumMapper = new RithumCarrierMapper();
    }

    /**
     * Get all available carriers with caching
     */
    async getAvailableCarriers() {
        // Check cache first
        if (this.carriersCache && this.cacheExpiry && Date.now() < this.cacheExpiry) {
            return this.carriersCache;
        }

        try {
            console.log('🔍 Fetching available carriers from ShipStation...');
            const carriers = await this.shipstationClient.getCarriers();
            
            // Cache the results
            this.carriersCache = carriers;
            this.cacheExpiry = Date.now() + this.CACHE_DURATION_MS;
            
            console.log(`✅ Found ${carriers ? carriers.length : 0} available carriers`);
            return carriers;
        } catch (error) {
            console.error('❌ Failed to fetch carriers:', error.message);
            throw error;
        }
    }

    /**
     * Select the best carrier for a given order
     * @param {Object} orderData - The order being processed
     * @param {Object} shipToAddress - Destination address
     * @param {Object} rithumOrderData - Original Rithum order data (optional)
     * @returns {String|null} - Selected carrier ID or null if none suitable
     */
    async selectCarrier(orderData, shipToAddress = null, rithumOrderData = null) {
        try {
            const carriers = await this.getAvailableCarriers();
            
            if (!carriers || carriers.length === 0) {
                console.warn('⚠️  No carriers available');
                return null;
            }

            console.log(`🔍 Evaluating ${carriers.length} available carriers...`);

            // 1. Check Rithum carrier requirements first
            let rithumRequirements = null;
            let preferredCarrierIds = [];
            
            if (rithumOrderData) {
                console.log('\n📋 Processing Rithum carrier requirements...');
                rithumRequirements = this.rithumMapper.extractCarrierRequirements(rithumOrderData);
                preferredCarrierIds = this.rithumMapper.getPreferredCarrierIds(rithumRequirements);
                
                if (preferredCarrierIds.length > 0) {
                    console.log(`🎯 Rithum prefers carriers: ${preferredCarrierIds.join(', ')}`);
                    
                    // Try preferred carriers first
                    for (const carrierId of preferredCarrierIds) {
                        const validation = this.rithumMapper.validateCarrierChoice(carrierId, rithumRequirements, carriers);
                        if (validation.isValid && validation.satisfiesRequirement) {
                            console.log(`✅ Selected Rithum-preferred carrier: ${carrierId}`);
                            console.log(`   Reason: ${validation.reason}`);
                            console.log(`   Carrier: ${validation.carrierInfo.carrier_code} - ${validation.carrierInfo.name || 'N/A'}`);
                            return carrierId;
                        } else if (!validation.isValid) {
                            console.log(`❌ Rithum-preferred carrier ${carrierId} is not available: ${validation.reason}`);
                        }
                    }
                    
                    // If we have strict requirements and no preferred carriers work, log warning
                    if (rithumRequirements.isRequired) {
                        console.log(`⚠️  None of Rithum's required carriers are available. Falling back to intelligent selection.`);
                    }
                }
            }

            // 2. Fall back to intelligent selection based on order characteristics
            console.log('\n🧠 Falling back to intelligent carrier selection...');
            
            // Filter active carriers
            const activeCarriers = carriers.filter(carrier => 
                carrier.is_active !== false && 
                carrier.carrier_id && 
                carrier.carrier_code
            );

            console.log(`🔍 Evaluating ${activeCarriers.length} active carriers...`);

            // Define carrier preferences based on various factors
            const carrierPreferences = this.getCarrierPreferences(orderData, shipToAddress, rithumRequirements);
            
            // Find the best match
            const selectedCarrier = this.findBestCarrier(activeCarriers, carrierPreferences);
            
            if (selectedCarrier) {
                console.log(`🚚 Selected carrier: ${selectedCarrier.carrier_id} (${selectedCarrier.carrier_code} - ${selectedCarrier.name || 'N/A'})`);
                
                // Validate against Rithum requirements if any
                if (rithumRequirements) {
                    const validation = this.rithumMapper.validateCarrierChoice(selectedCarrier.carrier_id, rithumRequirements, carriers);
                    if (!validation.satisfiesRequirement && rithumRequirements.isRequired) {
                        console.log(`⚠️  Selected carrier may not fully satisfy Rithum requirements: ${validation.reason}`);
                    } else if (!validation.satisfiesRequirement) {
                        console.log(`ℹ️  Selected carrier differs from Rithum preference but is acceptable: ${validation.reason}`);
                    }
                }
                
                return selectedCarrier.carrier_id;
            } else {
                console.warn('⚠️  No suitable carrier found');
                return null;
            }
        } catch (error) {
            console.error('❌ Error selecting carrier:', error.message);
            // Return fallback carrier as last resort
            return this.getFallbackCarrier();
        }
    }

    /**
     * Get carrier preferences based on order characteristics
     */
    getCarrierPreferences(orderData, shipToAddress, rithumRequirements = null) {
        const preferences = {
            // Preferred carrier codes in order of preference
            preferredCodes: ['usps', 'ups', 'fedex'],
            // Preferred service types
            preferredServices: ['ground', 'standard', 'first_class'],
            // Avoid certain carriers for specific conditions
            avoidCodes: []
        };

        // 1. Adjust preferences based on Rithum requirements
        if (rithumRequirements && rithumRequirements.requestedCarrier) {
            const rithumCarrier = rithumRequirements.requestedCarrier.toLowerCase();
            
            // Put Rithum's preferred carrier first
            if (rithumCarrier === 'usps' || rithumCarrier === 'generic') {
                preferences.preferredCodes = ['usps', 'ups', 'fedex'];
            } else if (rithumCarrier === 'ups') {
                preferences.preferredCodes = ['ups', 'usps', 'fedex'];
            } else if (rithumCarrier === 'fedex') {
                preferences.preferredCodes = ['fedex', 'ups', 'usps'];
            }
            
            console.log(`   📋 Rithum carrier preference: ${rithumCarrier} -> preferredCodes: ${preferences.preferredCodes.join(', ')}`);
        }

        // 2. Adjust based on Rithum service requirements
        if (rithumRequirements && rithumRequirements.serviceCode) {
            const serviceCode = rithumRequirements.serviceCode.toUpperCase();
            
            if (serviceCode.includes('EXPRESS') || serviceCode.includes('OVERNIGHT')) {
                preferences.preferredServices = ['express', 'overnight', 'priority'];
                // Prioritize carriers better for express
                preferences.preferredCodes = ['fedex', 'ups', 'usps'];
            } else if (serviceCode.includes('GROUND')) {
                preferences.preferredServices = ['ground', 'standard'];
                // USPS is great for ground
                if (!preferences.preferredCodes[0] === 'usps') {
                    preferences.preferredCodes.unshift('usps');
                }
            }
            
            console.log(`   🎯 Rithum service code: ${serviceCode} -> preferredServices: ${preferences.preferredServices.join(', ')}`);
        }

        // 3. Adjust preferences based on destination country
        if (shipToAddress && shipToAddress.country_code) {
            if (shipToAddress.country_code !== 'US') {
                // International shipping - prefer carriers with good international support
                preferences.preferredCodes = ['usps', 'fedex', 'ups'];
                preferences.preferredServices = ['international', 'priority', 'express'];
            }
        }

        // 4. Adjust based on order value or weight (if available)
        const orderTotal = orderData.order_total || orderData.total_amount || orderData.amountPaid || 0;
        if (orderTotal > 500) {
            // High-value orders - prefer carriers with better tracking/insurance
            if (!rithumRequirements || !rithumRequirements.isRequired) {
                // Only override if Rithum doesn't have strict requirements
                preferences.preferredCodes = ['ups', 'fedex', 'usps'];
            }
        }

        return preferences;
    }

    /**
     * Find the best carrier based on preferences
     */
    findBestCarrier(activeCarriers, preferences) {
        // Score each carrier
        const scoredCarriers = activeCarriers.map(carrier => {
            let score = 0;
            const carrierCode = (carrier.carrier_code || '').toLowerCase();
            const serviceName = (carrier.name || carrier.service_name || '').toLowerCase();

            // Score based on preferred carrier codes
            preferences.preferredCodes.forEach((prefCode, index) => {
                if (carrierCode.includes(prefCode)) {
                    score += (preferences.preferredCodes.length - index) * 10;
                }
            });

            // Score based on service type
            preferences.preferredServices.forEach((prefService, index) => {
                if (serviceName.includes(prefService)) {
                    score += (preferences.preferredServices.length - index) * 5;
                }
            });

            // Penalty for carriers to avoid
            preferences.avoidCodes.forEach(avoidCode => {
                if (carrierCode.includes(avoidCode)) {
                    score -= 20;
                }
            });

            // Special handling for USPS carriers (multiple accounts)
            if (carrierCode.includes('usps')) {
                // Prefer Ground Advantage and First Class
                if (serviceName.includes('ground') || serviceName.includes('advantage')) {
                    score += 15;
                } else if (serviceName.includes('first') && serviceName.includes('class')) {
                    score += 10;
                }
            }

            return { ...carrier, score };
        });

        // Sort by score (highest first) and return the best one
        scoredCarriers.sort((a, b) => b.score - a.score);
        
        // Log top 3 candidates for debugging
        console.log('🏆 Top carrier candidates:');
        scoredCarriers.slice(0, 3).forEach((carrier, index) => {
            console.log(`   ${index + 1}. ${carrier.carrier_id} (${carrier.carrier_code}) - Score: ${carrier.score} - ${carrier.name || 'N/A'}`);
        });

        return scoredCarriers.length > 0 ? scoredCarriers[0] : null;
    }

    /**
     * Get fallback carrier ID as last resort
     */
    getFallbackCarrier() {
        console.warn('🚨 Using fallback carrier (se-287927) - consider reviewing carrier selection logic');
        return 'se-287927'; // Primary USPS account as fallback
    }

    /**
     * Validate that a specific carrier ID exists and is active
     */
    async validateCarrier(carrierId) {
        try {
            const carriers = await this.getAvailableCarriers();
            const carrier = carriers.find(c => c.carrier_id === carrierId);
            
            if (!carrier) {
                console.warn(`⚠️  Carrier ${carrierId} not found`);
                return false;
            }

            if (carrier.is_active === false) {
                console.warn(`⚠️  Carrier ${carrierId} is not active`);
                return false;
            }

            console.log(`✅ Carrier ${carrierId} is valid and active`);
            return true;
        } catch (error) {
            console.error(`❌ Error validating carrier ${carrierId}:`, error.message);
            return false;
        }
    }

    /**
     * Get carrier information by ID
     */
    async getCarrierInfo(carrierId) {
        try {
            const carriers = await this.getAvailableCarriers();
            const carrier = carriers.find(c => c.carrier_id === carrierId);
            return carrier || null;
        } catch (error) {
            console.error(`❌ Error getting carrier info for ${carrierId}:`, error.message);
            return null;
        }
    }

    /**
     * Clear the carriers cache (useful for testing or forced refresh)
     */
    clearCache() {
        this.carriersCache = null;
        this.cacheExpiry = null;
        console.log('🗑️ Carrier cache cleared');
    }
}

module.exports = CarrierSelector;