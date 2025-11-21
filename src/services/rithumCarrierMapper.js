/**
 * Rithum to ShipStation Carrier Mapping Service
 * Maps Rithum carrier requests to actual ShipStation carrier IDs
 */

class RithumCarrierMapper {
    constructor() {
        // Map Rithum carrier names to ShipStation carrier preferences
        this.carrierMapping = {
            // Rithum carrier name -> Preferred ShipStation carriers (in order)
            'generic': ['se-287927', 'se-1015030'], // USPS accounts
            'usps': ['se-287927', 'se-1015030'],
            'ups': ['se-733076'],
            'fedex': ['se-283655'],
            'dhl': ['se-782807'],
            'stamps.com': ['se-287927', 'se-1015030'],
            'stamps_com': ['se-287927', 'se-1015030']
        };

        // Map service level codes to carrier preferences
        this.serviceMapping = {
            // Service code -> Preferred carriers for that service
            'GCG': ['se-287927', 'se-1015030'], // Generic Carrier Ground -> USPS
            'GCP': ['se-287927', 'se-1015030'], // Generic Carrier Priority -> USPS
            'GCE': ['se-287927', 'se-1015030'], // Generic Carrier Express -> USPS
            'FEDEX_GROUND': ['se-283655'],
            'FEDEX_2_DAY': ['se-283655'],
            'FEDEX_OVERNIGHT': ['se-283655'],
            'UPS_GROUND': ['se-733076'],
            'UPS_2ND_DAY': ['se-733076'],
            'UPS_NEXT_DAY': ['se-733076'],
            'USPS_GROUND_ADVANTAGE': ['se-287927', 'se-1015030'],
            'USPS_PRIORITY_MAIL': ['se-287927', 'se-1015030'],
            'USPS_PRIORITY_MAIL_EXPRESS': ['se-287927', 'se-1015030']
        };
    }

    /**
     * Extract carrier requirements from Rithum order
     * @param {Object} rithumOrder - Original Rithum order data
     * @returns {Object} Carrier requirements
     */
    extractCarrierRequirements(rithumOrder) {
        const requirements = {
            requestedCarrier: null,
            serviceCode: null,
            shipMethod: null,
            preferredCarrierIds: [],
            isRequired: false // Whether the carrier selection is strict
        };

        // Extract carrier information
        requirements.requestedCarrier = (
            rithumOrder.requestedShipCarrier || 
            rithumOrder.shipCarrier || 
            ''
        ).toLowerCase().trim();

        // Extract service information
        requirements.serviceCode = (
            rithumOrder.requestedShippingServiceLevelCode || 
            rithumOrder.shippingServiceLevelCode || 
            ''
        ).toUpperCase().trim();

        requirements.shipMethod = (
            rithumOrder.requestedShipMethod || 
            rithumOrder.shipMethod || 
            ''
        ).toLowerCase().trim();

        // Determine if this is a strict requirement
        // If Rithum explicitly requests a specific carrier, treat it as required
        requirements.isRequired = !!(
            rithumOrder.requestedShipCarrier || 
            rithumOrder.requestedShippingServiceLevelCode
        );

        console.log(`🔍 Rithum carrier requirements:`);
        console.log(`   Requested Carrier: ${requirements.requestedCarrier || 'None'}`);
        console.log(`   Service Code: ${requirements.serviceCode || 'None'}`);
        console.log(`   Ship Method: ${requirements.shipMethod || 'None'}`);
        console.log(`   Is Required: ${requirements.isRequired ? 'Yes' : 'No (fallback allowed)'}`);

        return requirements;
    }

    /**
     * Get preferred carrier IDs based on Rithum requirements
     * @param {Object} carrierRequirements - Result from extractCarrierRequirements
     * @returns {Array} Array of carrier IDs in preference order
     */
    getPreferredCarrierIds(carrierRequirements) {
        const preferredIds = [];

        // 1. First try service code mapping (most specific)
        if (carrierRequirements.serviceCode && this.serviceMapping[carrierRequirements.serviceCode]) {
            preferredIds.push(...this.serviceMapping[carrierRequirements.serviceCode]);
            console.log(`   🎯 Service code '${carrierRequirements.serviceCode}' maps to: ${preferredIds.join(', ')}`);
        }

        // 2. Then try carrier name mapping
        if (carrierRequirements.requestedCarrier && this.carrierMapping[carrierRequirements.requestedCarrier]) {
            const carrierIds = this.carrierMapping[carrierRequirements.requestedCarrier];
            // Add to list if not already present
            carrierIds.forEach(id => {
                if (!preferredIds.includes(id)) {
                    preferredIds.push(id);
                }
            });
            console.log(`   🚚 Carrier '${carrierRequirements.requestedCarrier}' adds: ${carrierIds.join(', ')}`);
        }

        // 3. Handle special cases based on ship method
        if (carrierRequirements.shipMethod) {
            if (carrierRequirements.shipMethod.includes('ground') && !preferredIds.some(id => id.startsWith('se-287'))) {
                if (!preferredIds.includes('se-287927')) {
                    preferredIds.push('se-287927'); // USPS good for ground
                }
            } else if (carrierRequirements.shipMethod.includes('express') || carrierRequirements.shipMethod.includes('overnight')) {
                // Express shipping - prioritize FedEx/UPS
                if (!preferredIds.includes('se-283655')) {
                    preferredIds.unshift('se-283655'); // FedEx for express
                }
                if (!preferredIds.includes('se-733076')) {
                    preferredIds.splice(1, 0, 'se-733076'); // UPS for express
                }
            }
        }

        console.log(`   ✅ Final preferred carriers: ${preferredIds.join(', ')}`);
        return [...new Set(preferredIds)]; // Remove duplicates while preserving order
    }

    /**
     * Check if a carrier ID satisfies Rithum requirements
     * @param {string} carrierId - ShipStation carrier ID
     * @param {Object} carrierRequirements - Rithum requirements
     * @param {Array} availableCarriers - Available carriers from ShipStation
     * @returns {Object} Validation result
     */
    validateCarrierChoice(carrierId, carrierRequirements, availableCarriers) {
        const result = {
            isValid: false,
            satisfiesRequirement: false,
            carrierInfo: null,
            reason: ''
        };

        // Find carrier info
        const carrierInfo = availableCarriers.find(c => c.carrier_id === carrierId);
        if (!carrierInfo) {
            result.reason = `Carrier ${carrierId} not found in available carriers`;
            return result;
        }

        result.isValid = carrierInfo.is_active !== false;
        result.carrierInfo = carrierInfo;

        if (!result.isValid) {
            result.reason = `Carrier ${carrierId} is not active`;
            return result;
        }

        // Check if it satisfies Rithum requirements
        const preferredIds = this.getPreferredCarrierIds(carrierRequirements);
        result.satisfiesRequirement = preferredIds.length === 0 || preferredIds.includes(carrierId);

        if (result.satisfiesRequirement) {
            result.reason = preferredIds.length === 0 
                ? 'No specific carrier required by Rithum'
                : `Carrier ${carrierId} matches Rithum requirement`;
        } else if (carrierRequirements.isRequired) {
            result.reason = `Carrier ${carrierId} does not match strict Rithum requirement (${carrierRequirements.requestedCarrier}, ${carrierRequirements.serviceCode})`;
        } else {
            result.reason = `Carrier ${carrierId} does not match Rithum preference but fallback allowed`;
            result.satisfiesRequirement = true; // Allow fallback when not strictly required
        }

        return result;
    }

    /**
     * Add service code mapping for custom integrations
     * @param {string} serviceCode - Rithum service code
     * @param {Array} carrierIds - Preferred ShipStation carrier IDs
     */
    addServiceMapping(serviceCode, carrierIds) {
        this.serviceMapping[serviceCode.toUpperCase()] = carrierIds;
        console.log(`➕ Added service mapping: ${serviceCode} -> ${carrierIds.join(', ')}`);
    }

    /**
     * Add carrier name mapping for custom integrations
     * @param {string} carrierName - Rithum carrier name
     * @param {Array} carrierIds - Preferred ShipStation carrier IDs
     */
    addCarrierMapping(carrierName, carrierIds) {
        this.carrierMapping[carrierName.toLowerCase()] = carrierIds;
        console.log(`➕ Added carrier mapping: ${carrierName} -> ${carrierIds.join(', ')}`);
    }

    /**
     * Get all current mappings for debugging
     * @returns {Object} All mappings
     */
    getMappings() {
        return {
            carrierMapping: this.carrierMapping,
            serviceMapping: this.serviceMapping
        };
    }
}

module.exports = RithumCarrierMapper;