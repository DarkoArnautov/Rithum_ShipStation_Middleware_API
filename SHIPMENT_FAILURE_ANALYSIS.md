# Rithum Shipment Update Failure - Root Cause Analysis

**Date**: November 14, 2025  
**Order ID**: 1026063960  
**Status**: ❌ FAILED - Shipment not added to Rithum

---

## Executive Summary

The shipment update to Rithum **FAILED** because an invalid shipping code was sent:

**Root Cause**: `shippingServiceLevelCode` = **"GCG"** (INVALID for shipments)

- ✅ "GCG" is valid for **ORDERS** 
- ❌ "GCG" is **NOT** valid for **SHIPMENTS/PACKAGES**
- ✅ Should have been mapped to **"USGA"** (USPS Ground Advantage)

---

## Failed Order Details

| Property | Value |
|----------|-------|
| **Rithum Order ID** | 1026063960 |
| **PO Number** | BOX.75593715.69954264 |
| **ShipStation Shipment ID** | se-920983006 |
| **Tracking Number** | 9400150206242019517336 |
| **Order Lifecycle** | acknowledged (stuck) |
| **Order Status** | shipment_pending ❌ |
| **Packages in Rithum** | 0 ❌ |
| **Order Requested Code** | GCG (order-level) |
| **Expected Package Code** | USGA |
| **Actual Package Code Sent** | GCG ❌ |
| **Carrier** | USPS |
| **Service** | usps_ground_advantage |

---

## Comparison: Successful vs Failed Orders

### ✅ **SUCCESSFUL ORDERS** (3 completed orders)

#### Order 1022178919
- **Order Code**: GCG (order-level) 
- **Package Code**: **USGA** ✅ (USPS Ground Advantage)
- **Carrier**: USPS
- **Weight**: 1 LB
- **Tracking**: 9400150899562158461951
- **Lifecycle**: **completed** ✅

#### Order 1022844358
- **Order Code**: GCG (order-level)
- **Package Code**: **USGA** ✅ (USPS Ground Advantage)
- **Carrier**: USPS
- **Weight**: 1 LB
- **Tracking**: 9400150899563165959721
- **Lifecycle**: **completed** ✅

#### Order 1025416768
- **Order Code**: GCG (order-level)
- **Package Code**: **UPCG** ✅ (UPS Ground)
- **Carrier**: UPS
- **Weight**: 0.3 kg
- **Tracking**: 1ZAC66381515974728
- **Lifecycle**: **completed** ✅

### ❌ **FAILED ORDER** (Order 1026063960)

- **Order Code**: GCG (order-level)
- **Package Code Sent**: **"GCG"** ❌ **INVALID!**
- **Expected Code**: **USGA** (based on USPS Ground Advantage service)
- **Carrier**: USPS (from ShipStation)
- **Service Code**: usps_ground_advantage
- **Tracking**: 9400150206242019517336 (exists in ShipStation)
- **Lifecycle**: **acknowledged** (stuck - shipment never added)
- **Status**: **shipment_pending** ❌

---

## The Problem Explained

### 1. Understanding "GCG"

**"GCG"** likely means "Generic Carrier Ground":
- ✅ **Valid for ORDERS**: Used at order creation to indicate generic ground shipping
- ❌ **Invalid for SHIPMENTS**: Rithum requires specific carrier codes when adding packages

### 2. How It Should Work

When creating shipments, "GCG" must be mapped to carrier-specific codes:

| Carrier | Service | Code | Description |
|---------|---------|------|-------------|
| USPS | Ground Advantage | **USGA** | USPS Ground Advantage |
| USPS | Priority Mail | **USPM** | USPS Priority Mail |
| UPS | Ground | **UPCG** | UPS Ground |
| UPS | Next Day Air | **UPSV** | UPS Next Day Air |
| UPS | 2nd Day Air | **UPSP** | UPS 2nd Day Air |
| FedEx | Ground | **FECG** | FedEx Ground |
| FedEx | 2Day | **FEHD** | FedEx 2Day |
| FedEx | Express | **FESP** | FedEx Express |

**Valid shipment codes**: `ASEE, ASEP, ASEL, ASET, FECG, FEHD, FESP, ONCG, PSDD, UPCG, UPSV, UPSP, USGA, USPM`

### 3. What Happened

**Successful Orders** (3 orders):
1. Webhook receives ShipStation shipment with carrier info
2. Code detects "GCG" is not valid for shipments
3. Code maps based on actual carrier used:
   - USPS Ground Advantage → **USGA** ✅
   - UPS Ground → **UPCG** ✅
4. Rithum accepts shipment with valid code
5. Order lifecycle: acknowledged → **completed** ✅

**Failed Order** (1026063960):
1. Webhook receives ShipStation shipment
2. Code somehow uses "GCG" directly ❌
3. Async request submitted to Rithum:
   ```json
   {
     "shippingServiceLevelCode": "GCG",  // ❌ INVALID!
     "trackingNumber": "9400150206242019517336",
     ...
   }
   ```
4. Rithum's async processor silently rejects the request
5. Order stuck at lifecycle: **acknowledged** ❌
6. Shipment never added (0 packages) ❌

---

## Why We Couldn't See the Error

### API Limitation Discovered

The `/order/changelog` API endpoint returns **403 Forbidden**:
```
GET /order/changelog?requestId=1823ba54-3d92-4a86-9f3c-420e4d498213
Status: 403
Message: "Invalid key=value pair (missing equal-sign) in Authorization header"
```

**Impact**:
- Cannot check async request status via `requestId`
- Cannot see actual validation error messages from Rithum
- Had to verify by polling the order directly
- Confirmed: order has 0 packages = shipment was rejected

**Workaround**:
- Created `verify-shipment-update.js` to poll order directly
- Polls Rithum order multiple times to check if package was added
- Confirmed the shipment was NOT added after 30 seconds

---

## Investigation Findings

### Key Discoveries

1. ✅ **All orders use "GCG" at order level** - This is correct and expected
2. ✅ **Successful orders map GCG → valid shipment codes** - USGA or UPCG based on carrier
3. ❌ **Failed order sent "GCG" for shipment** - Invalid code caused silent rejection
4. ✅ **Webhook mapping function works correctly** - When tested independently:
   ```javascript
   mapToRithumShippingMethod('se-287927', 'usps_ground_advantage')
   // Returns: 'USGA' ✅
   ```
5. ❓ **Logic bug somewhere in execution** - Despite correct validation logic on lines 389-410, "GCG" was sent

### Code Analysis

The validation logic in `webhook_step2.js` (lines 389-410) **should** work:

```javascript
const validRithumCodes = ['ASEE', 'ASEP', 'ASEL', 'ASET', 'FECG', 'FEHD', 
                          'FESP', 'ONCG', 'PSDD', 'UPCG', 'UPSV', 'UPSP', 
                          'USGA', 'USPM'];

if (requestedShippingServiceLevelCode && 
    validRithumCodes.includes(requestedShippingServiceLevelCode)) {
    // Use requested code if valid
    rithumShippingMethod = requestedShippingServiceLevelCode;
} else {
    // Map from carrier/service
    rithumShippingMethod = mapToRithumShippingMethod(carrierCode || carrierName, shipMethod);
}
```

**Expected behavior**:
- "GCG" is NOT in `validRithumCodes` array
- Should go to `else` branch
- Should call `mapToRithumShippingMethod()` 
- Should return "USGA"

**Actual behavior**:
- "GCG" was sent to Rithum ❌

**Possible causes**:
1. The `carrierCode`, `carrierName`, or `shipMethod` values were null/incorrect
2. The mapping function returned "GCG" as a fallback (shouldn't happen)
3. There's another code path that overrides the value
4. The payload was built incorrectly somewhere else
5. No actual request payload logging to confirm what was sent

---

## Diagnostic Tools Created

During this investigation, three diagnostic tools were created:

### 1. `check-async-status.js` ❌ (Blocked)
**Purpose**: Check status of async Rithum requests using requestId

**Status**: Cannot use - `/order/changelog` endpoint returns 403 Forbidden

**Usage**: 
```bash
node check-async-status.js <requestId>
node check-async-status.js 1823ba54-3d92-4a86-9f3c-420e4d498213
```

### 2. `verify-shipment-update.js` ✅ (Working)
**Purpose**: Poll Rithum order to verify if shipment was actually added

**Status**: Working - confirmed order 1026063960 has 0 packages after 30 seconds

**Usage**: 
```bash
node verify-shipment-update.js <rithumOrderId> <trackingNumber>
node verify-shipment-update.js 1026063960 9400150206242019517336
```

**Output**: Polls order 10 times with 3-second delays, reports if shipment was added

### 3. `diagnose-shipment.js` ✅ (Working)
**Purpose**: Analyze ShipStation shipment and show what would be sent to Rithum

**Status**: Working - revealed the expected "USGA" code vs actual "GCG" issue

**Usage**: 
```bash
node diagnose-shipment.js <shipment_id>
node diagnose-shipment.js se-920983006
```

**Output**: Shows shipment details, order lifecycle, and predicted Rithum payload

---

## Recommended Actions

### 1. ✅ Fix webhook_step2.js (PRIORITY 1)

**Required changes**:
- Add explicit rejection of "GCG" and other order-only codes
- Ensure mapping always uses carrier/service codes when order code is invalid
- Add final payload validation before sending to Rithum
- Enhance logging to capture actual payload sent (not just built)
- Add a safety check that validates `shippingServiceLevelCode` is in valid list

**Location**: Lines 385-460 in `webhook_step2.js`

### 2. ✅ Fix Failed Order 1026063960 (PRIORITY 2)

**Create retry script** to:
- Fetch shipment details from ShipStation (se-920983006)
- Build correct payload with **USGA** code
- Submit to Rithum order 1026063960
- Verify shipment was added using `verify-shipment-update.js`

### 3. ✅ Add Post-Submission Verification (PRIORITY 3)

**Enhance webhook** to:
- After submitting shipment, wait 5-10 seconds
- Poll Rithum order to verify package was added
- If not added after 30 seconds, log error and alert
- Store failed submissions for manual retry

### 4. 📧 Contact Rithum Support

**Request**:
- Access to `/order/changelog` endpoint
- Currently returns 403 Forbidden
- Need this for debugging async request failures
- Would provide actual error messages from validation failures

---

## Files Modified/Created

| File | Status | Purpose |
|------|--------|---------|
| `check-async-status.js` | ❌ Blocked | Check async request status (403 error) |
| `verify-shipment-update.js` | ✅ Working | Verify shipment was added by polling order |
| `diagnose-shipment.js` | ✅ Working | Analyze shipment and predict payload |
| `SHIPMENT_FAILURE_ANALYSIS.md` | ✅ Created | This comprehensive analysis document |
| `webhook_step2.js` | ⏳ Needs Fix | Shipping code validation logic |

---

## Verification Summary

### Orders Analyzed
- ✅ 3 successful shipped orders retrieved and analyzed
- ✅ 1 failed order retrieved and analyzed
- ✅ All compared to identify differences

### Tests Performed
- ✅ Confirmed failed order has 0 packages in Rithum
- ✅ Confirmed successful orders have packages with valid codes (USGA, UPCG)
- ✅ Confirmed all orders use "GCG" at order level
- ✅ Confirmed mapping function produces correct result when tested
- ✅ Verified tracking number exists in ShipStation
- ✅ Verified order lifecycle is "acknowledged" (valid for adding shipments)

---

## Next Steps

**Ready to proceed with fixes:**

1. **Fix webhook_step2.js** - Prevent "GCG" from ever being sent for shipments
2. **Create retry script** - Fix the failed order 1026063960
3. **Add verification** - Ensure future shipments are verified after submission

**Would you like me to proceed with implementing these fixes?**
