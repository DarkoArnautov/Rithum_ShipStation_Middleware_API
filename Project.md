# Rithum-ShipStation Middleware API

A custom middleware API that integrates Rithum (DSCO platform) with ShipStation, allowing automated order synchronization and tracking updates.

## Overview

This middleware bridges Rithum and ShipStation:

- **Orders Flow**: Rithum → Middleware (via Event Streams) → ShipStation
- **Tracking Flow**: ShipStation (via Webhooks) → Middleware → Rithum

### Architecture

```
┌──────────┐         ┌──────────────┐         ┌──────────────┐
│  Rithum  │────────▶│  Middleware  │────────▶│ ShipStation  │
│ (Orders) │         │   (Cron Job) │         │              │
└──────────┘         └──────────────┘         └──────────────┘
                            │                         │
                            │                         │
                            │      ┌──────────────┐   │
                            │◀─────│   Webhooks   │◀──┘
                            │      │ (Tracking)   │
                            │      └──────────────┘
                            │
                            ▼
                     ┌──────────────┐
                     │   Rithum     │
                     │ (Update)     │
                     └──────────────┘
```

## Quick Start

### Prerequisites

- Node.js 16+
- Rithum API credentials (Client ID, Client Secret)
- ShipStation API credentials (API Key, API Secret)

### Installation

```bash
# Install dependencies
npm install

# Configure environment variables (see Configuration section)
cp .env.example .env  # Edit with your credentials

# Start server
npm start
```

### Configuration

Create a `.env` file with:

```env
# Rithum Configuration
RITHUM_API_URL=https://api.dsco.io/api/v3
RITHUM_CLIENT_ID=your_client_id
RITHUM_CLIENT_SECRET=your_client_secret

# ShipStation Configuration
SHIPSTATION_API_KEY=your_api_key
SHIPSTATION_API_SECRET=your_api_secret
SHIPSTATION_BASE_URL=https://ssapi.shipstation.com
SHIPSTATION_WEBHOOK_URL=https://your-domain.com/api/shipstation/webhooks/order-notify

# Sync Schedule (Cron format, default: every 5 minutes)
ORDER_SYNC_SCHEDULE=*/5 * * * *

# Server Configuration
PORT=8000
NODE_ENV=production
```

### Initial Setup

1. **Initialize Rithum Order Stream**:
   ```bash
   curl -X POST http://localhost:8000/api/rithum/stream/initialize
   ```

2. **Verify Configuration**:
   ```bash
   curl http://localhost:8000/api/rithum/status
   curl http://localhost:8000/api/shipstation/status
   ```

3. **Configure ShipStation Webhooks**:
   - Log into ShipStation
   - Go to Settings → Integrations → Webhooks
   - Add webhook: Event = "Order Notify", URL = your webhook URL

## API Endpoints

### Rithum Endpoints

- `GET /api/rithum/test` - Test Rithum connection
- `GET /api/rithum/status` - Get Rithum client status
- `GET /api/rithum/orders` - Fetch orders from Rithum
- `POST /api/rithum/stream/initialize` - Initialize order event stream
- `GET /api/rithum/stream/status` - Get stream status
- `GET /api/rithum/stream/new-orders` - Check for new orders

### ShipStation Endpoints

- `GET /api/shipstation/ping` - Health check
- `GET /api/shipstation/test` - Test ShipStation connection
- `GET /api/shipstation/status` - Get ShipStation status
- `POST /api/shipstation/webhooks/order-notify` - Webhook for tracking updates

### Sync Endpoints

- `POST /api/sync/orders` - Manually trigger order sync
- `GET /api/sync/status` - Get sync service status

## Order Detection & Synchronization

### How It Works

The system uses **Rithum Event Streams** to detect new orders (webhooks not available):

1. **Event Stream**: Creates a stream that captures order events
2. **Cron Job**: Periodically polls the stream for new orders (default: every 5 minutes)
3. **Filter**: Identifies `create` events (new orders)
4. **Fetch Details**: Gets full order information from Rithum
5. **Map & Send**: Converts format and sends to ShipStation

### Manual Operations

**Check for New Orders**:
```bash
curl http://localhost:8000/api/rithum/stream/new-orders
```

**Manual Sync**:
```bash
curl -X POST http://localhost:8000/api/sync/orders
```

**Check Sync Status**:
```bash
curl http://localhost:8000/api/sync/status
```

### Cron Schedule

The `ORDER_SYNC_SCHEDULE` uses standard cron format:

- `*/5 * * * *` - Every 5 minutes (default)
- `*/10 * * * *` - Every 10 minutes
- `0 * * * *` - Every hour
- `0 0 * * *` - Once daily at midnight

## Webhooks (ShipStation → Rithum)

When ShipStation ships an order, it sends a webhook to:

`POST /api/shipstation/webhooks/order-notify`

The middleware:
1. Receives the webhook notification
2. Fetches full order details from ShipStation
3. Extracts tracking information (tracking number, carrier, ship date)
4. Updates the Rithum order with tracking information

**Webhook Configuration in ShipStation**:
- Event: Order Notify
- URL: `https://your-domain.com/api/shipstation/webhooks/order-notify`
- Format: JSON

## Data Mapping

### Overview

Orders from Rithum must be transformed to ShipStation's format before being sent. This requires a mapping service that handles field transformations, data validation, and format conversions.

**Current Status**: ⚠️ Mapping documentation exists but **no implementation yet**. A mapping service needs to be created.

### Order Mapping Service Implementation

**Recommended Service**: Create `src/services/orderMapper.js` to handle all transformations.

**Key Responsibilities**:
1. Transform Rithum order format → ShipStation order format
2. Handle field mappings and data type conversions
3. Validate required fields
4. Apply business rules (status mapping, defaults)
5. Handle edge cases and missing data

### Order Field Mapping

| ShipStation Field | Rithum Field | Notes | Required |
|-------------------|--------------|-------|----------|
| `orderNumber` | `poNumber` | Primary identifier | ✅ Yes |
| `orderDate` | `consumerOrderDate` | Fallback to `retailerCreateDate` | ✅ Yes |
| `orderStatus` | `dscoStatus` | Status mapping applied (see below) | ✅ Yes |
| `amountPaid` | `extendedExpectedCostTotal` | Order total | ✅ Yes |
| `currencyCode` | `"USD"` | Default currency if not specified | ⚠️ Default |
| `customField1` | `channel` | Optional: Store channel | ❌ No |
| `customField2` | `dscoOrderId` | **Required**: Store Rithum order ID for tracking | ✅ Yes |
| `customerUsername` | `shipping.name` | Customer name | ⚠️ Optional |
| `shipByDate` | `shipByDate` | Format conversion may be needed | ⚠️ Optional |
| `orderKey` | `dscoOrderId` | Alternative identifier | ⚠️ Optional |

### Shipping Address Mapping

| ShipStation Field (v1) | ShipStation Field (v2) | Rithum Field | Notes | Required |
|-------------|--------|-------|-------|----------|
| `name` | `name` | `shipping.name` or `shipping.firstName + lastName` | Combine if name missing | ✅ Yes |
| `street1` | `address_line1` | `shipping.address1` | First line of address | ✅ Yes |
| `street2` | `address_line2` | `shipping.address[1]` | Second address line if exists | ❌ No |
| `city` | `city_locality` | `shipping.city` | City name | ✅ Yes |
| `state` | `state_province` | `shipping.state` or `shipping.region` | State code | ✅ Yes |
| `postalCode` | `postal_code` | `shipping.postal` | ZIP/postal code | ✅ Yes |
| `country` | `country_code` | `shipping.country` | Country code (default: "US") | ✅ Yes |
| `phone` | `phone` | `shipping.phone` | Phone number (required in v2, optional in v1) | ⚠️ v2: Required, v1: Optional |
| N/A | `address_residential_indicator` | N/A | v2 only: "yes", "no", "unknown" | ⚠️ v2: Required |

**Note**: Current implementation uses **v1 format**. The `openapi.yaml` file contains v2 API spec (different field names).

### Line Items Mapping

Each Rithum `lineItem` maps to ShipStation `item`:

| ShipStation Field | Rithum Field | Notes | Required |
|-------------|--------|-------|----------|
| `sku` | `sku` or `partnerSku` | Use `sku`, fallback to `partnerSku` | ✅ Yes |
| `name` | `title` | Product name | ✅ Yes |
| `quantity` | `quantity` or `acceptedQuantity` | Prefer `acceptedQuantity` if available | ✅ Yes |
| `unitPrice` | `expectedCost` or `consumerPrice` | Use `expectedCost` for supplier cost | ✅ Yes |
| `imageUrl` | N/A | Not available in Rithum | ❌ No |
| `weight` | N/A | Not available in Rithum | ❌ No |
| `options` | `personalization` | Store as option if present | ⚠️ Optional |

### Order Status Mapping

| Rithum Status | ShipStation Status | Notes |
|---------------|-------------------|-------|
| `created` | `awaiting_shipment` | New order |
| `shipment_pending` | `awaiting_shipment` | Ready to ship |
| `shipped` | `shipped` | Already shipped |
| `cancelled` | `cancelled` | Cancelled order |

**Important**: Only process orders with status `created` or `shipment_pending` for new orders. Skip `shipped` and `cancelled`.

### API Version Note

⚠️ **Important**: The codebase uses **ShipStation v1 API** (`/orders/createorder`), not v2.

- **v1 Format** (currently used): `street1`, `city`, `state`, `postalCode`, `country`
- **v2 Format** (in openapi.yaml): `address_line1`, `city_locality`, `state_province`, `postal_code`, `country_code`, `address_residential_indicator`

The mapper implementation uses **v1 format**. If migrating to v2 API, the mapper will need updates.

### How to Check Which API Version You Can Use

**Quick Test** (Recommended):
```bash
# Run the test script to check both API versions
node test-shipstation-api-version.js
```

This script will:
- Test v1 API endpoint
- Test v2 API endpoint
- Show which version(s) are available
- Provide recommendations

**1. Check ShipStation Account Settings**:
   - Log into ShipStation web interface (https://ss.shipstation.com)
   - Go to **Settings** → **Account** → **API Settings** (or **API** section)
   - Check which API version is enabled/available
   - Look for API documentation links or version indicators
   - Note: API access might need to be enabled in your account settings

**2. Test via API Endpoints**:

   **Test v1 API** (current):
   ```bash
   # Test v1 endpoint
   curl -u "YOUR_API_KEY:YOUR_API_SECRET" \
     "https://ssapi.shipstation.com/orders?pageSize=1"
   
   # If 200 OK → v1 is available
   # If 404 → v1 might not be available
   ```

   **Test v2 API**:
   ```bash
   # Test v2 endpoint
   curl -u "YOUR_API_KEY:YOUR_API_SECRET" \
     "https://api.shipstation.com/v2/orders?page_size=1"
   
   # If 200 OK → v2 is available
   # If 404 → v2 might not be available for your account
   ```

**3. Check API Documentation Access**:
   - In ShipStation account, look for **API Documentation** section
   - See which version's documentation is available
   - Check for any migration notices or deprecation warnings

**4. Review Account Plan/Features**:
   - Some API versions might be tied to account tier
   - Enterprise accounts may have access to v2
   - Check your plan details for API access

**5. Test Current Implementation**:
   ```bash
   # Using the test endpoint in your codebase
   curl http://localhost:8000/api/shipstation/test
   
   # Or test directly with curl
   curl -u "YOUR_API_KEY:YOUR_API_SECRET" \
     "https://ssapi.shipstation.com/orders?pageSize=1"
   
   # If 200 OK → v1 is active
   # If 401 → Check credentials or API access enabled
   # If 404 → v1 endpoint might not be available
   ```

**6. Check ShipStation Dashboard/Announcements**:
   - Look for any announcements about API version changes
   - Check for migration guides
   - Review recent emails from ShipStation about API updates

**Recommended Approach**:
1. Start with your current v1 implementation (already working)
2. Test v1 endpoint to confirm it's active
3. If v1 works, continue using it
4. If v1 is deprecated/unavailable, migrate to v2
5. Update mapper and client when migrating to v2

**Migration Checklist** (if moving to v2):
- Update `shipstationClient.js` base URL to `https://api.shipstation.com`
- Update endpoint from `/orders/createorder` to `/v2/orders` (check exact v2 endpoint)
- Update `orderMapper.js` field names (street1 → address_line1, etc.)
- Add `address_residential_indicator` field
- Test thoroughly before deploying

### Implementation Example

**Service Structure** (`src/services/orderMapper.js`):

```javascript
class OrderMapper {
    /**
     * Map Rithum order to ShipStation order format
     * @param {Object} rithumOrder - Order from Rithum API
     * @returns {Object} ShipStation order format
     */
    mapToShipStation(rithumOrder) {
        return {
            orderNumber: rithumOrder.poNumber,
            orderDate: this.mapOrderDate(rithumOrder),
            orderStatus: this.mapOrderStatus(rithumOrder.dscoStatus),
            amountPaid: rithumOrder.extendedExpectedCostTotal,
            currencyCode: "USD",
            customerUsername: this.getCustomerName(rithumOrder.shipping),
            shipByDate: rithumOrder.shipByDate || null,
            orderKey: rithumOrder.dscoOrderId,
            customField1: rithumOrder.channel || null,
            customField2: rithumOrder.dscoOrderId, // Required for tracking
            shipTo: this.mapShippingAddress(rithumOrder.shipping),
            items: this.mapLineItems(rithumOrder.lineItems || []),
            // Optional fields
            advancedOptions: {
                customField1: rithumOrder.channel
            }
        };
    }

    mapOrderDate(rithumOrder) {
        return rithumOrder.consumerOrderDate || 
               rithumOrder.retailerCreateDate || 
               new Date().toISOString();
    }

    mapOrderStatus(rithumStatus) {
        const statusMap = {
            'created': 'awaiting_shipment',
            'shipment_pending': 'awaiting_shipment',
            'shipped': 'shipped',
            'cancelled': 'cancelled'
        };
        return statusMap[rithumStatus] || 'awaiting_shipment';
    }

    getCustomerName(shipping) {
        if (shipping?.name) return shipping.name;
        if (shipping?.firstName && shipping?.lastName) {
            return `${shipping.firstName} ${shipping.lastName}`;
        }
        return 'Customer';
    }

    mapShippingAddress(shipping) {
        if (!shipping) {
            throw new Error('Shipping address is required');
        }

        return {
            name: this.getCustomerName(shipping),
            street1: shipping.address1 || '',
            street2: shipping.address?.[1] || null,
            city: shipping.city || '',
            state: shipping.state || shipping.region || '',
            postalCode: shipping.postal || '',
            country: shipping.country || 'US',
            phone: shipping.phone || null
        };
    }

    mapLineItems(lineItems) {
        return lineItems.map((item, index) => ({
            sku: item.sku || item.partnerSku || `ITEM-${index}`,
            name: item.title || 'Unknown Item',
            quantity: item.acceptedQuantity || item.quantity || 1,
            unitPrice: item.expectedCost || item.consumerPrice || 0,
            ...(item.personalization && {
                options: [{
                    name: 'Personalization',
                    value: item.personalization
                }]
            })
        }));
    }

    /**
     * Validate that order can be mapped
     * @param {Object} rithumOrder - Order from Rithum
     * @returns {Object} Validation result
     */
    validate(rithumOrder) {
        const errors = [];

        if (!rithumOrder.poNumber) {
            errors.push('Missing poNumber');
        }
        if (!rithumOrder.shipping) {
            errors.push('Missing shipping address');
        } else {
            if (!rithumOrder.shipping.address1) errors.push('Missing address1');
            if (!rithumOrder.shipping.city) errors.push('Missing city');
            if (!rithumOrder.shipping.state && !rithumOrder.shipping.region) {
                errors.push('Missing state/region');
            }
            if (!rithumOrder.shipping.postal) errors.push('Missing postal code');
        }
        if (!rithumOrder.lineItems || rithumOrder.lineItems.length === 0) {
            errors.push('Missing line items');
        }
        if (!rithumOrder.dscoOrderId) {
            errors.push('Missing dscoOrderId');
        }

        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Check if order should be processed
     * @param {Object} rithumOrder - Order from Rithum
     * @returns {boolean} Should process
     */
    shouldProcess(rithumOrder) {
        // Skip test orders if configured
        if (process.env.SKIP_TEST_ORDERS === 'true' && rithumOrder.testFlag) {
            return false;
        }

        // Only process certain statuses
        const processableStatuses = ['created', 'shipment_pending'];
        return processableStatuses.includes(rithumOrder.dscoStatus);

        // Skip cancelled orders
        if (rithumOrder.dscoStatus === 'cancelled') {
            return false;
        }

        return true;
    }
}

module.exports = OrderMapper;
```

### Usage in Sync Service

```javascript
const OrderMapper = require('./services/orderMapper');
const mapper = new OrderMapper();

// In sync workflow:
const shipstationOrder = mapper.mapToShipStation(rithumOrder);

// Validate before sending
const validation = mapper.validate(rithumOrder);
if (!validation.isValid) {
    console.error('Order validation failed:', validation.errors);
    // Handle error
}

// Check if should process
if (!mapper.shouldProcess(rithumOrder)) {
    console.log('Skipping order:', rithumOrder.dscoOrderId);
    return;
}

// Send to ShipStation
await shipstationClient.createOrder(shipstationOrder);
```

### Edge Cases to Handle

1. **Missing Shipping Address**: 
   - Required field - should fail validation
   - Log error, skip order

2. **Missing Line Items**:
   - Required field - should fail validation
   - Log error, skip order

3. **Empty SKU**:
   - Use fallback: `partnerSku` or generate `ITEM-{index}`
   - Log warning

4. **Missing Customer Name**:
   - Use fallback: "Customer" or combine first/last name
   - Should not fail

5. **Missing Currency**:
   - Default to "USD"
   - Should not fail

6. **Invalid Dates**:
   - Validate ISO format
   - Use current date as fallback if invalid

7. **Test Orders**:
   - Check `testFlag`
   - Skip if configured to skip test orders

8. **Zero Quantity Items**:
   - Filter out or skip items with quantity 0
   - Log warning

### Testing Mapping

Create test cases using your `orders.json` sample data:

```javascript
// test/orderMapper.test.js
const OrderMapper = require('../src/services/orderMapper');
const sampleOrders = require('../orders.json');

const mapper = new OrderMapper();

sampleOrders.data.forEach((rithumOrder, index) => {
    const shipstationOrder = mapper.mapToShipStation(rithumOrder);
    const validation = mapper.validate(rithumOrder);
    
    console.log(`Order ${index + 1}:`, {
        rithumId: rithumOrder.dscoOrderId,
        poNumber: rithumOrder.poNumber,
        isValid: validation.isValid,
        errors: validation.errors,
        shipstationOrderNumber: shipstationOrder.orderNumber
    });
});
```

### Integration Points

**Where Mapping is Used**:
1. **Sync Service** (when implemented): Transform orders before sending to ShipStation
2. **Manual Sync Endpoint**: Transform orders on demand
3. **Stream Processing**: Transform new orders from stream
4. **Retry Logic**: Transform failed orders for retry

**Next Steps for Implementation**:
1. ✅ Create `src/services/orderMapper.js` with mapping logic
2. ✅ Add validation and error handling
3. ✅ Create unit tests with sample data
4. ✅ Integrate with sync service
5. ✅ Add logging for mapping operations
6. ✅ Handle edge cases and missing data

**Note**: Rithum order ID (`dscoOrderId`) must be stored in ShipStation's `customField2` for tracking and updates.

## Error Handling & Resilience

### Overview

The system must handle various error scenarios to ensure reliable order synchronization. This section outlines error handling strategies, detection methods, and recovery procedures.

### Error Categories

#### 1. Network & API Unavailability Errors

**Scenario**: Rithum API is unreachable, times out, or returns 5xx errors.

**Current Behavior**:
- Retry logic with exponential backoff (3 attempts)
- 30-second timeout per request
- Non-retriable 4xx errors fail immediately (except 429 rate limits)

**Recommended Monitoring**:
- Track API response times
- Monitor 5xx error rates
- Alert on consecutive failures (>3)
- Log all failed requests with timestamps

**Recovery Strategies**:
1. **Automatic Retry**: Already implemented with exponential backoff
2. **Circuit Breaker Pattern**: Consider implementing to prevent cascade failures
3. **Fallback Mechanism**: Queue failed requests for later processing
4. **Health Checks**: Regular API connectivity tests

**Detection**:
```bash
# Monitor API health
curl http://localhost:8000/api/rithum/status

# Check for errors in logs
# Look for: "Rithum API Error", "ECONNREFUSED", "ETIMEDOUT", "timeout"
```

#### 2. Bulk Order Scenarios (CSV Uploads, Mass Imports)

**Scenario**: Large number of orders (e.g., 300+) added simultaneously via CSV upload or bulk import in Rithum.

**Potential Issues**:

**A. Rate Limiting (429 Errors)**:
- Fetching 300 orders simultaneously = 300 API calls at once
- Rithum API may have rate limits (e.g., 100 requests/minute)
- `Promise.all()` in `checkForNewOrders()` fires all requests in parallel
- Result: Many requests will get 429 (Too Many Requests) errors

**B. Memory Consumption**:
- Loading 300 full order objects into memory at once
- Each order can be 10-50KB of JSON data
- Total: 3-15MB of data in memory simultaneously
- Can cause Node.js heap issues on smaller servers

**C. Timeout Issues**:
- Current timeout: 30 seconds per request
- With rate limiting, some requests may wait longer
- If many requests fail/retry, total processing time can exceed minutes
- HTTP request timeouts before completion

**D. Partial Failures**:
- Some orders fetched successfully, others fail
- Stream position updated but not all orders processed
- Difficult to track which orders were successfully retrieved
- May need to retry only failed orders

**E. Stream Position Update Issues** ⚠️ **CRITICAL**:
- **Current Behavior**: Position updates based on events retrieved, NOT on successful order processing
- All 300 events processed but only 250 orders fetched successfully
- Position still updates to last event ID regardless of fetch failures
- **Result**: 50 orders are permanently lost (position advanced past them)
- Risk of missing orders if position advances too far
- No rollback mechanism if order fetching fails partially

**Current Code Issue**:
```javascript
// Current implementation - PROBLEMATIC
const lastEventId = allEvents.length > 0 
    ? allEvents[allEvents.length - 1].id 
    : currentPosition;

// Updates position even if order fetching failed!
if (lastEventId && lastEventId !== this.lastPosition) {
    this.lastPosition = lastEventId;
    await this.saveStreamConfig();
}
```

**The Problem**: Position advances based on events retrieved, not orders successfully processed.

**Current Behavior Analysis**:

Looking at `checkForNewOrders()`:
```javascript
// Current implementation uses Promise.all() - all requests fire at once
const orderPromises = newOrderIds.map(orderId => 
    this.getOrderById(orderId).catch(error => {
        console.warn(`Failed to fetch order ${orderId}:`, error.message);
        return { id: orderId, error: error.message };
    })
);
orderDetails = await Promise.all(orderPromises);
```

**Problems with this approach**:
- ✅ Error handling exists (catches individual failures)
- ❌ No rate limiting - all requests fire simultaneously
- ❌ No batching - doesn't process in chunks
- ❌ No retry logic for rate-limited requests
- ❌ No progress tracking for large batches

**Recommended Solutions**:

1. **Implement Request Batching**:
   - Process orders in batches of 10-50 at a time
   - Wait for batch to complete before starting next batch
   - Add delay between batches to avoid rate limits
   ```javascript
   // Pseudo-code example
   const batchSize = 20;
   const batchDelay = 1000; // 1 second between batches
   for (let i = 0; i < orderIds.length; i += batchSize) {
       const batch = orderIds.slice(i, i + batchSize);
       await Promise.all(batch.map(id => getOrderById(id)));
       await sleep(batchDelay);
   }
   ```

2. **Add Rate Limit Handling**:
   - Detect 429 responses
   - Implement exponential backoff for rate-limited requests
   - Queue requests when rate limit is hit
   - Retry rate-limited requests after delay

3. **Use Sequential Processing for Large Batches**:
   - If > 100 orders, switch from parallel to sequential/batched
   - Process 10-20 at a time with delays
   - Better than risking all 300 requests failing

4. **Implement Progress Tracking**:
   - Track success/failure counts
   - Log progress every N orders
   - Return partial results if timeout occurs
   - Don't update stream position until all orders processed

5. **Stream Position Safety** ⚠️ **CRITICAL FIX NEEDED**:
   - **Current Issue**: Position updates based on events retrieved, not successful processing
   - **Required Fix**: Only update position after ALL orders successfully fetched
   - **Incremental Updates**: For large batches, update position incrementally as batches succeed
   - **Failure Handling**: If partial failure, keep position at last successfully processed event
   - **Checkpoint System**: Implement checkpoints for large batches (e.g., every 50 orders)
   - **Validation**: Verify all orders fetched before advancing position
   - **Rollback Capability**: Ability to reset position if needed

**Recommended Position Update Logic**:
```javascript
// Safe approach - only advance position if all orders succeed
if (includeOrderDetails && newOrderIds.length > 0) {
    const failedOrders = orderDetails.filter(o => o.error);
    if (failedOrders.length === 0) {
        // All succeeded - safe to advance position
        this.lastPosition = lastEventId;
        await this.saveStreamConfig();
    } else {
        // Some failed - keep position at start, don't advance
        console.warn(`${failedOrders.length} orders failed to fetch. Position not updated.`);
        // Could also advance to last successfully processed event
    }
} else {
    // No details requested - safe to advance based on events
    this.lastPosition = lastEventId;
    await this.saveStreamConfig();
}
```

**Alternative: Incremental Position Updates**:
```javascript
// For large batches, update position as batches succeed
const BATCH_SIZE = 50;
for (let i = 0; i < newOrderIds.length; i += BATCH_SIZE) {
    const batch = newOrderIds.slice(i, i + BATCH_SIZE);
    const batchResults = await fetchBatch(batch);
    if (batchResults.allSucceeded) {
        // Advance position to last event in this batch
        const batchLastEvent = findLastEventForBatch(batch, allEvents);
        this.lastPosition = batchLastEvent.id;
        await this.saveStreamConfig(); // Checkpoint
    } else {
        // Stop processing, keep position at last successful batch
        break;
    }
}
```

6. **Memory Management**:
   - Stream process orders instead of loading all at once
   - Process and send to ShipStation in batches
   - Don't accumulate all order details in memory

**Detection**:

Monitor for:
- High number of 429 errors in logs
- Timeout errors when fetching orders
- Large number of orders detected in single check (> 50)
- Memory usage spikes during order processing
- Stream position not updating despite events processed
- **⚠️ CRITICAL**: Position advanced but orders have errors in response
- **⚠️ CRITICAL**: Mismatch between `newOrderCount` and successfully fetched orders

**How to Detect Position Issue**:
```bash
# Check if position advanced
curl http://localhost:8000/api/rithum/stream/status | jq '.lastPosition'

# Check for failed orders in response
curl http://localhost:8000/api/rithum/stream/new-orders | jq '{
  newOrderCount: .newOrderCount,
  ordersFetched: (.orders | length),
  failedOrders: [.orders[] | select(.error)]
}'

# If newOrderCount > ordersFetched, position may have advanced incorrectly
```

**Example Monitoring Query**:
```bash
# Check how many orders were detected
curl http://localhost:8000/api/rithum/stream/new-orders | jq '.newOrderCount'

# Check for errors in response
curl http://localhost:8000/api/rithum/stream/new-orders | jq '.orders[] | select(.error)'
```

**Recovery Strategies**:

1. **Retry Failed Orders**:
   ```bash
   # Get list of failed order IDs
   # Then retry fetching them individually or in small batches
   ```

2. **Process Without Details First**:
   ```bash
   # Get order IDs only (faster, no rate limit issues)
   curl "http://localhost:8000/api/rithum/stream/new-orders?includeDetails=false"
   
   # Then process order IDs in batches manually
   ```

3. **Use Orders API for Bulk Fetch**:
   ```bash
   # Instead of fetching individual orders, use paginated orders API
   curl "http://localhost:8000/api/rithum/orders?ordersCreatedSince=2025-10-31T00:00:00Z"
   ```

4. **Manual Batch Processing**:
   - Split 300 orders into 10 batches of 30
   - Process each batch with delay
   - Track which batches succeeded

**Recommended Implementation Approach**:

1. **Add Configuration**:
   ```env
   # Maximum parallel requests for order fetching
   MAX_PARALLEL_ORDER_REQUESTS=20
   # Delay between batches (ms)
   BATCH_DELAY_MS=1000
   # Switch to batching when order count exceeds
   BATCH_THRESHOLD=50
   ```

2. **Enhanced Error Tracking**:
   - Return detailed results: `{successful: [...], failed: [...], skipped: [...]}`
   - Track which orders failed and why
   - Provide retry mechanism for failed orders

3. **Stream Position Management**:
   - Only advance position when all orders in batch are processed
   - Implement checkpoint system for large batches
   - Save intermediate progress for recovery

**Best Practices for Bulk Orders**:

1. **Proactive Monitoring**: Alert when > 50 orders detected at once
2. **Graceful Degradation**: Process what you can, queue the rest
3. **Incremental Processing**: Don't block on large batches
4. **Error Isolation**: One failed order shouldn't block others
5. **Progress Visibility**: Log progress for large batches
6. **Recovery Mechanism**: Ability to resume from last successful position

#### 3. Missed Orders Detection

**Scenario**: Orders are created in Rithum but not detected by the stream API due to:
- Stream position corruption
- Events processed out of order
- Stream partition issues
- Long service downtime

**Detection Methods**:

**A. Position Gap Detection**:
- Compare `lastPosition` in `.stream-config.json` with stream's current position
- Large gaps indicate potential missed orders
- Check: `GET /api/rithum/stream/status` - compare `lastPosition` vs `stream.partitions[0].position`

**B. Time-based Gap Detection**:
- Track last successful sync timestamp
- If gap > 2x polling interval, investigate missed orders
- Example: If polling every 5 minutes and 20 minutes passed with no events, investigate

**C. Order ID Gap Detection**:
- Periodically query orders API with date filters
- Compare with orders already processed
- Identify orders in Rithum but not in processed list

**Recovery Strategies**:

1. **Backfill Missing Orders**:
   ```bash
   # Query orders from last known sync time
   curl "http://localhost:8000/api/rithum/orders?ordersCreatedSince=2025-10-30T00:00:00Z"
   ```
   - Compare returned orders with processed order IDs
   - Process missing orders manually

2. **Stream Reset** (Last Resort):
   ```bash
   # Delete .stream-config.json and reinitialize
   rm .stream-config.json
   curl -X POST http://localhost:8000/api/rithum/stream/initialize
   ```
   - **Warning**: Will reprocess all events from stream creation
   - Only use if you have deduplication logic

3. **Time Window Reconciliation**:
   - Periodically run reconciliation job (e.g., daily)
   - Query orders from last 24 hours
   - Compare with processed orders
   - Fill any gaps

**Prevention**:
- Regular health checks on stream status
- Monitor stream position updates
- Alert on position gaps
- Implement order deduplication in sync service

#### 4. Authentication & Authorization Errors

**Scenario**: 401 Unauthorized, 403 Forbidden, token expiration.

**Current Behavior**:
- Automatic token refresh on 401
- Retries request once after refresh

**Recommended Monitoring**:
- Track token refresh frequency
- Alert on repeated 401/403 errors
- Monitor token expiration times

**Recovery**:
- Automatic: Token refresh is handled automatically
- Manual: Verify credentials in `.env` file
- Check: `GET /api/rithum/token` for token status

**Detection**:
```bash
# Check token status
curl http://localhost:8000/api/rithum/token

# Look for 401/403 in logs
# Check: "Failed to obtain access token"
```

#### 5. Rate Limiting Errors

**Scenario**: 429 Too Many Requests from Rithum API.

**Current Behavior**:
- Retries are attempted for 429 errors
- Uses exponential backoff

**Recommended Strategies**:
1. **Rate Limiting**: Implement request throttling
2. **Request Queuing**: Queue requests during rate limits
3. **Backoff Strategy**: Increase delay on 429 (already implemented)
4. **Monitoring**: Track 429 frequency and adjust polling intervals

**Prevention**:
- Respect API rate limits (check Rithum API docs)
- Adjust polling frequency if hitting limits
- Use batch operations where possible

#### 6. Stream Position Tracking Errors

**Scenario**: Stream position becomes invalid, corrupted, or lost.

**Detection**:
- Compare stream position with last processed position
- Invalid position format in `.stream-config.json`
- Position doesn't exist in stream partition

**Recovery**:
1. **Check Stream Status**:
   ```bash
   curl http://localhost:8000/api/rithum/stream/status
   ```

2. **Validate Position**:
   - Check if `lastPosition` format matches stream partition position format
   - Verify position hasn't been corrupted

3. **Reset to Current Position**:
   - If position is invalid, update `.stream-config.json` with current stream position
   - **Note**: This may cause order reprocessing - ensure deduplication

4. **Manual Position Update**:
   ```json
   // Edit .stream-config.json
   {
     "streamId": "your-stream-id",
     "lastPosition": "current-partition-position",
     "updatedAt": "2025-10-31T12:00:00.000Z"
   }
   ```

#### 7. Data Consistency Errors

**Scenario**: Order data inconsistencies, missing fields, or mapping errors.

**Detection**:
- Failed order creation in ShipStation
- Invalid field mappings
- Missing required fields

**Recovery**:
1. **Log Failed Orders**: Store failed orders for investigation
2. **Validation**: Validate order data before sending to ShipStation
3. **Manual Review**: Review logs for patterns in failures
4. **Fallback Values**: Use default values for optional fields

#### 8. Stream Configuration File Errors

**Scenario**: Issues with `.stream-config.json` file operations.

**Potential Issues**:

**A. Corrupted JSON File**:
- Invalid JSON syntax in `.stream-config.json`
- File partially written (corrupted during save)
- Manual edits introducing syntax errors
- **Result**: Cannot load stream configuration, stream appears uninitialized

**B. File Permission Errors**:
- Read permission denied
- Write permission denied
- File locked by another process
- **Result**: Cannot save position updates, loses state

**C. Disk Space Issues**:
- Disk full when saving config
- Insufficient storage
- **Result**: Position updates fail silently

**D. Missing or Invalid Fields**:
- Missing `streamId` in config
- Invalid `lastPosition` format
- Missing `updatedAt` timestamp
- **Result**: Stream initialization issues or position errors

**Detection**:
```bash
# Check if config file exists and is valid JSON
cat .stream-config.json | jq .

# Check file permissions
ls -la .stream-config.json

# Check disk space
df -h .
```

**Recovery**:
1. **Backup and Recreate Config**:
   ```bash
   # Backup existing
   cp .stream-config.json .stream-config.json.backup
   
   # Validate JSON
   jq . .stream-config.json
   
   # If invalid, restore from backup or recreate
   ```

2. **Fix Permissions**:
   ```bash
   chmod 644 .stream-config.json
   ```

3. **Manual Position Recovery**:
   - Check stream status via API
   - Manually edit config with correct values
   - Ensure valid JSON format

#### 9. Stream API Errors (Stream Not Found, Deleted, Inactive)

**Scenario**: Stream becomes unavailable, deleted, or inactive.

**Potential Issues**:

**A. Stream Not Found (404)**:
- Stream was deleted in Rithum system
- Stream ID changed or expired
- Invalid stream ID in configuration
- **Result**: Cannot retrieve stream status or events

**B. Stream Deleted or Expired**:
- Stream lifecycle expired
- Admin deleted stream in Rithum
- Stream cleanup by Rithum system
- **Result**: Stream operations fail, need to recreate

**C. Stream Partition Issues**:
- No partitions available in stream
- Partition ID mismatch
- Partition status is "inactive" or "error"
- **Result**: Cannot read events from stream

**D. Invalid Position Format**:
- Position string doesn't match expected format
- Position doesn't exist in stream partition
- Position was from a different stream
- **Result**: Cannot fetch events, stream operations fail

**E. Stream Becomes Inactive**:
- Stream status changes to "inactive"
- Partition status becomes "error"
- **Result**: Events cannot be read from stream

**Detection**:
```bash
# Check stream status
curl http://localhost:8000/api/rithum/stream/status | jq '{
  initialized: .initialized,
  streamId: .streamId,
  stream: .stream,
  error: .error
}'

# Check for stream not found errors in logs
# Look for: "Stream not found", "404", "Stream ${streamId} not found"
```

**Recovery**:
1. **Reinitialize Stream**:
   ```bash
   # Delete old config
   rm .stream-config.json
   
   # Create new stream
   curl -X POST http://localhost:8000/api/rithum/stream/initialize
   ```

2. **Verify Stream Exists**:
   - Check Rithum dashboard if available
   - Try to fetch stream directly
   - Verify stream ID is correct

3. **Manual Stream Recreation**:
   - If stream deleted, create new one
   - Update `.stream-config.json` with new stream ID
   - Reset position to start or known good position

#### 10. Order Not Found Errors (404)

**Scenario**: Order ID exists in stream event but order doesn't exist when fetching details.

**Potential Issues**:

**A. Order Deleted After Event**:
- Order created and event fired
- Order deleted before fetching details
- Order cancelled and removed
- **Result**: 404 error when fetching order details

**B. Invalid Order ID Format**:
- Order ID from event is malformed
- Order ID format changed in Rithum
- Encoding issues with order ID
- **Result**: Cannot fetch order, invalid endpoint

**C. Order ID Mismatch**:
- Event contains wrong order ID
- Order ID changed between event and fetch
- **Result**: Order not found

**Detection**:
```bash
# Check for failed order fetches
curl http://localhost:8000/api/rithum/stream/new-orders | jq '.orders[] | select(.error)'

# Look for 404 errors in response
curl http://localhost:8000/api/rithum/stream/new-orders | jq '.orders[] | select(.error) | select(.error | contains("404"))'
```

**Recovery**:
1. **Skip Deleted Orders**:
   - Log order ID as skipped/deleted
   - Continue processing other orders
   - Don't fail entire batch for one deleted order

2. **Retry Logic**:
   - Retry once after delay (order might be temporarily unavailable)
   - If still 404, mark as deleted and skip

3. **Manual Investigation**:
   - Check order ID in Rithum system directly
   - Verify order actually exists
   - Check if order was deleted/cancelled

#### 11. Invalid Event Data or Format Errors

**Scenario**: Stream events contain unexpected or invalid data.

**Potential Issues**:

**A. Missing Event Fields**:
- Event missing `objectId` (order ID)
- Event missing `eventReason`
- Event missing `id` (event ID)
- **Result**: Cannot process event, order ID unknown

**B. Invalid Event Types**:
- Unexpected `eventReason` values (not "create", "update", "delete")
- Malformed event structure
- **Result**: Events filtered out or cause errors

**C. Duplicate Events**:
- Same event ID processed multiple times
- Events retrieved multiple times
- Position not advancing correctly
- **Result**: Orders processed multiple times

**D. Events Out of Order**:
- Events not in chronological order
- Position jumps backward
- **Result**: Orders processed in wrong order

**E. Malformed Event Data**:
- Invalid JSON in event payload
- Missing required event metadata
- **Result**: Cannot parse or process events

**Detection**:
```bash
# Check all events for issues
curl "http://localhost:8000/api/rithum/stream/new-orders?showAllEvents=true" | jq '{
  totalEvents: .eventsSummary.total,
  eventsWithIssues: [.allEvents[] | select(.objectId == null or .eventReason == null)],
  duplicateEventIds: (.allEvents | group_by(.id) | map(select(length > 1)))
}'
```

**Recovery**:
1. **Validate Event Data**:
   - Check for required fields before processing
   - Log invalid events for investigation
   - Skip invalid events, continue with valid ones

2. **Deduplication**:
   - Track processed event IDs
   - Skip already processed events
   - Prevent duplicate order processing

3. **Order Validation**:
   - Verify events are for orders (correct `objectType`)
   - Filter unexpected event types
   - Handle gracefully

#### 12. Concurrency and Race Condition Errors

**Scenario**: Multiple requests or instances accessing stream simultaneously.

**Potential Issues**:

**A. Concurrent Position Updates**:
- Multiple API calls reading same position
- Both process same events
- Both update position, causing overwrite
- **Result**: Some events processed twice, others skipped

**B. File Locking Issues**:
- Multiple instances trying to write `.stream-config.json`
- File write conflicts
- **Result**: Position updates lost or corrupted

**C. Multiple Service Instances**:
- Multiple middleware instances running
- All polling same stream
- All processing same events
- **Result**: Duplicate processing, race conditions

**D. Simultaneous Stream Initialization**:
- Multiple requests initializing stream at once
- Multiple streams created
- **Result**: Multiple streams, confusion about which to use

**Detection**:
- Monitor for duplicate order processing
- Check logs for concurrent file writes
- Verify only one instance is running
- Look for position jumping backward or forward unexpectedly

**Recovery**:
1. **Ensure Single Instance**:
   - Use process manager (PM2, systemd) to ensure single instance
   - Implement file locking for config updates
   - Use database instead of file for position tracking (if multiple instances needed)

2. **Implement Locking**:
   - Use file locks when writing config
   - Use mutex/lock for position updates
   - Queue concurrent requests

3. **Deduplication**:
   - Track processed order IDs
   - Skip already processed orders
   - Use transactional updates if possible

#### 13. Network and Timeout Specific Errors

**Scenario**: Network-level issues specific to stream or order operations.

**Potential Issues**:

**A. Partial Response Timeout**:
- Stream events endpoint responds slowly
- Large event batch times out mid-response
- **Result**: Partial events received, position unclear

**B. Connection Reset During Fetch**:
- Network connection dropped mid-request
- Connection reset by peer
- **Result**: Order fetch incomplete, partial data

**C. DNS Resolution Failures**:
- Rithum API hostname cannot be resolved
- DNS server issues
- **Result**: Cannot connect to API, all requests fail

**D. SSL/TLS Certificate Errors**:
- Certificate expired or invalid
- SSL handshake failures
- **Result**: Cannot establish secure connection

**Detection**:
```bash
# Check network connectivity
curl -v https://api.dsco.io/api/v3/oauth2/token

# Check DNS resolution
nslookup api.dsco.io

# Check SSL certificate
openssl s_client -connect api.dsco.io:443
```

**Recovery**:
- Automatic retries (already implemented)
- Increase timeout values for large batches
- Check network connectivity
- Verify DNS and SSL certificates

#### 14. Data Validation and Schema Errors

**Scenario**: Order data doesn't match expected format or schema.

**Potential Issues**:

**A. Missing Required Fields**:
- Order missing `poNumber`, `lineItems`, or shipping address
- Required fields null or empty
- **Result**: Cannot map order to ShipStation format

**B. Invalid Data Types**:
- Date fields in wrong format
- Numeric fields as strings (or vice versa)
- Boolean fields as strings
- **Result**: Data mapping failures, type errors

**C. Schema Mismatches**:
- Order structure changed in Rithum API
- New required fields added
- Field names changed
- **Result**: Mapping errors, missing data in ShipStation

**D. Data Corruption**:
- Invalid characters in order data
- Encoding issues (UTF-8 problems)
- Malformed JSON in nested fields
- **Result**: Parsing errors, incomplete data

**Detection**:
- Validate order data before mapping
- Check for required fields
- Log validation errors
- Monitor mapping failures

**Recovery**:
- Implement data validation
- Use fallback values for optional fields
- Log validation failures for investigation
- Handle schema changes gracefully

#### 15. Service Downtime & Recovery

**Scenario**: Middleware service is down for extended period.

**Recovery Procedure**:
1. **Calculate Downtime Window**: Determine how long service was down
2. **Backfill Orders**: Query orders created during downtime
   ```bash
   # Get orders from downtime start to now
   curl "http://localhost:8000/api/rithum/orders?ordersCreatedSince=2025-10-30T12:00:00Z"
   ```
3. **Process Missing Orders**: Sync orders not yet processed
4. **Update Stream Position**: Reset to appropriate position if needed
5. **Verify Integrity**: Run reconciliation check

### Monitoring & Alerting Recommendations

#### Key Metrics to Monitor

1. **API Health**:
   - Response times (should be < 2 seconds)
   - Error rates (5xx, 4xx)
   - Success rate (> 99%)

2. **Stream Health**:
   - Stream position updates
   - Events processed per interval
   - Position gaps (lastPosition vs current position)

3. **Order Processing**:
   - Orders detected per check
   - Orders successfully synced
   - Failed order syncs
   - Processing latency

4. **System Health**:
   - Service uptime
   - Token refresh success rate
   - Memory/CPU usage

#### Recommended Alerts

1. **Critical Alerts** (Immediate Action Required):
   - API unavailable for > 5 minutes
   - Stream position gap > 1000 events
   - Token refresh failures
   - Service crashes/restarts

2. **Warning Alerts** (Investigate Soon):
   - High error rate (> 5% in 5 minutes)
   - Rate limiting (429 errors)
   - Stream position not updating
   - No orders detected for > 2 hours (if expecting orders)
   - Large batch detected (> 50 orders in single check) - may need special handling
   - High number of failed order fetches in bulk scenarios
   - Stream configuration file errors or permission issues
   - Stream not found or inactive
   - Order not found (404) errors
   - Invalid event data or missing fields
   - Concurrent access detected (multiple instances)
   - Data validation failures
   - Network timeouts or connection issues

3. **Info Alerts** (Monitor):
   - Token refresh events
   - Unusual order volumes
   - Slow API responses

### Error Logging Best Practices

**What to Log**:
- All API errors with full context (URL, status, response)
- Stream position changes
- Failed order syncs with order IDs
- Token refresh events
- Service start/stop events
- Manual interventions (position resets, etc.)

**Log Format**:
```json
{
  "timestamp": "2025-10-31T12:00:00.000Z",
  "level": "error",
  "service": "stream-api",
  "error": "API request failed",
  "details": {
    "endpoint": "/stream/...",
    "status": 500,
    "message": "Internal Server Error",
    "retryAttempt": 2,
    "streamId": "...",
    "lastPosition": "..."
  }
}
```

### Manual Recovery Checklist

When errors occur, follow this checklist:

1. **Check Service Status**:
   ```bash
   curl http://localhost:8000/ping
   curl http://localhost:8000/api/rithum/status
   curl http://localhost:8000/api/rithum/stream/status
   ```

2. **Review Recent Logs**: Check for error patterns

3. **Verify Stream Position**:
   ```bash
   curl http://localhost:8000/api/rithum/stream/status | jq '.lastPosition'
   ```

4. **Check for Missed Orders**:
   - Calculate time since last successful sync
   - Query orders API for that time window
   - Compare with processed orders

5. **Test API Connectivity**:
   ```bash
   curl http://localhost:8000/api/rithum/token
   ```

6. **Manual Sync Test**:
   ```bash
   curl http://localhost:8000/api/rithum/stream/new-orders
   ```

7. **Recovery Actions**:
   - Fix identified issues
   - Backfill missing orders if needed
   - Reset stream position if corrupted
   - Restart service if needed

### Best Practices Summary

1. **Regular Monitoring**: Check logs and metrics daily
2. **Position Validation**: Regularly verify stream position is updating
3. **Backup Strategy**: Keep backups of `.stream-config.json`
4. **Deduplication**: Always deduplicate orders when reprocessing
5. **Graceful Degradation**: Handle partial failures without stopping service
6. **Documentation**: Document all manual interventions
7. **Testing**: Regularly test error scenarios in staging
8. **Reconciliation**: Run daily reconciliation jobs to catch missed orders

## Troubleshooting

### Sync Not Running

1. Check configuration:
   ```bash
   curl http://localhost:8000/api/sync/status
   ```

2. Verify credentials are set in `.env`

3. Check server logs for errors

### Orders Not Syncing

1. Check if new orders are detected:
   ```bash
   curl http://localhost:8000/api/rithum/stream/new-orders
   ```

2. Verify stream is initialized:
   ```bash
   curl http://localhost:8000/api/rithum/stream/status
   ```

3. Try manual sync:
   ```bash
   curl -X POST http://localhost:8000/api/sync/orders
   ```

### Webhooks Not Working

1. Verify webhook URL is publicly accessible (not localhost)

2. Check ShipStation webhook configuration

3. Test webhook endpoint:
   ```bash
   curl http://localhost:8000/api/shipstation/ping
   ```

4. Check server logs for incoming requests

### Tracking Not Updating in Rithum

1. Verify webhook is being received (check logs)

2. Check if Rithum order ID is correctly mapped

3. Verify Rithum update API permissions

### API Not Responding

1. Check network connectivity to Rithum API
2. Verify API URL in configuration
3. Check for firewall/network issues
4. Review retry logs - may be temporarily down
5. See "Error Handling & Resilience" section above for detailed recovery steps

### Missed Orders

1. Check stream position status:
   ```bash
   curl http://localhost:8000/api/rithum/stream/status
   ```

2. Identify time window of potential missed orders

3. Query orders for that window:
   ```bash
   curl "http://localhost:8000/api/rithum/orders?ordersCreatedSince=YYYY-MM-DDTHH:mm:ssZ"
   ```

4. Compare with processed orders list

5. See "Missed Orders Detection" in "Error Handling & Resilience" section for detailed procedures

### Bulk Orders (CSV Uploads) - Rate Limiting Issues

**Symptoms**:
- Many 429 (Too Many Requests) errors in logs
- Timeout errors when fetching order details
- Only partial orders fetched (e.g., 200 out of 300)
- High memory usage during processing
- **Position advanced but orders missing** (critical issue - see below)

**Immediate Actions**:

1. **Check how many orders were detected**:
   ```bash
   curl http://localhost:8000/api/rithum/stream/new-orders | jq '.newOrderCount'
   ```

2. **Check for failed order fetches**:
   ```bash
   curl http://localhost:8000/api/rithum/stream/new-orders | jq '.orders[] | select(.error)'
   ```

3. **Get order IDs only (without details)** to avoid rate limits:
   ```bash
   curl "http://localhost:8000/api/rithum/stream/new-orders?includeDetails=false"
   ```

4. **Alternative: Use paginated orders API** instead of individual fetches:
   ```bash
   curl "http://localhost:8000/api/rithum/orders?ordersCreatedSince=YYYY-MM-DDTHH:mm:ssZ"
   ```

**Prevention for Future**:
- See "Bulk Order Scenarios" in "Error Handling & Resilience" section
- Consider implementing batching for order fetching
- Monitor for bulk order scenarios and process in batches

**Recovery**:
- Retry failed orders in small batches (10-20 at a time)
- Add delays between batches to avoid rate limits
- Process orders incrementally rather than all at once

**⚠️ Critical: Stream Position Issue**

If you see that position advanced but orders are missing:

1. **Check current position vs last processed**:
   ```bash
   curl http://localhost:8000/api/rithum/stream/status | jq '.lastPosition'
   ```

2. **Check for missing orders**:
   - Identify the time window when bulk upload happened
   - Query orders API for that window
   - Compare with what was actually processed

3. **Manual Position Rollback** (if needed):
   ```bash
   # Find the last successfully processed event position
   # Edit .stream-config.json and set lastPosition to that event ID
   # Warning: This will cause events to be reprocessed
   ```

4. **Prevent Future Issues**:
   - Use `includeDetails=false` for bulk scenarios first
   - Process order IDs in batches
   - Only advance position after batch succeeds
   - Monitor for failed order fetches before position updates

## Database vs File-Based Storage: When is a Database Needed?

### Current Implementation (File-Based)

**What's Currently Stored**:
- Stream position in `.stream-config.json` (streamId, lastPosition, updatedAt)
- No tracking of processed orders
- No error logs or retry queues
- No historical data

**Current Limitations**:
- ❌ No deduplication - can't check if order already processed
- ❌ Concurrency issues - multiple instances can't share state
- ❌ No audit trail - can't query what was processed when
- ❌ No error tracking - failed orders not persisted for retry
- ❌ File locking issues with concurrent writes
- ❌ No querying capabilities - can't search/filter processed orders
- ❌ Position corruption risk - no transactional updates

### When File-Based is Sufficient

✅ **Use file-based storage if**:
- **Single instance deployment** - only one middleware instance running
- **Simple use case** - basic order sync without complex requirements
- **Low volume** - small number of orders (< 100/day)
- **No historical tracking needed** - don't need to query past orders
- **No deduplication required** - ShipStation handles duplicates
- **Minimal error recovery** - errors handled manually or by retrying stream
- **No analytics needed** - don't need reporting on processed orders

**Pros of File-Based**:
- ✅ Simple setup - no database installation/maintenance
- ✅ Low overhead - minimal dependencies
- ✅ Easy backup - just copy JSON file
- ✅ Fast reads/writes for small data
- ✅ No infrastructure complexity

### When a Database is Recommended

⚠️ **Consider a database if you have**:

**1. Multiple Instances / High Availability**:
- Running multiple middleware instances for redundancy
- Need shared state across instances
- File-based locking is problematic
- **Database benefit**: ACID transactions, concurrent access, locking

**2. Order Deduplication Requirements**:
- Need to track processed order IDs
- Prevent duplicate processing if stream reprocesses events
- Query if order was already sent to ShipStation
- **Database benefit**: Fast lookups, indexed queries, persistence

**3. Error Tracking & Retry Queues**:
- Track failed orders for retry
- Persistent error logs
- Retry scheduling
- **Database benefit**: Query failed orders, scheduled retries, error analytics

**4. Audit Trail & Compliance**:
- Track when orders were processed
- Historical records of all operations
- Compliance requirements
- **Database benefit**: Timestamps, queryable history, reports

**5. Bulk Order Handling**:
- Process large batches (300+ orders)
- Need checkpoint system for partial failures
- Track processing status per order
- **Database benefit**: Transactional updates, batch operations, status tracking

**6. Analytics & Reporting**:
- Reports on processed orders
- Metrics on sync performance
- Error rate analysis
- **Database benefit**: Aggregations, joins, time-series queries

**7. Stream Position Safety**:
- Critical that position only advances after successful processing
- Need transactional position updates
- Recovery from partial failures
- **Database benefit**: Transactions ensure atomicity

### Recommended Database Options

#### 1. **SQLite (Lightweight, Recommended for Start)**

**Best for**: Single instance, simple requirements, easy deployment

**Pros**:
- ✅ File-based database - no server needed
- ✅ ACID transactions
- ✅ SQL queries
- ✅ Simple setup (npm install sqlite3)
- ✅ Low overhead
- ✅ Good for deduplication and basic tracking

**Cons**:
- ❌ Not ideal for multiple instances (file locking)
- ❌ Limited concurrent writes

**Use when**: Starting out, single instance, need better than files but not full database

**Schema Example**:
```sql
CREATE TABLE processed_orders (
    order_id TEXT PRIMARY KEY,
    rithum_order_id TEXT,
    processed_at DATETIME,
    stream_event_id TEXT,
    status TEXT, -- 'processed', 'failed', 'retry'
    error_message TEXT,
    retry_count INTEGER DEFAULT 0
);

CREATE TABLE stream_state (
    stream_id TEXT PRIMARY KEY,
    last_position TEXT,
    updated_at DATETIME
);

CREATE INDEX idx_order_id ON processed_orders(order_id);
CREATE INDEX idx_status ON processed_orders(status);
```

#### 2. **PostgreSQL (Production, Multiple Instances)**

**Best for**: Production, multiple instances, complex requirements

**Pros**:
- ✅ Full ACID compliance
- ✅ Excellent concurrency handling
- ✅ Advanced queries and indexes
- ✅ JSON support for flexible schemas
- ✅ Time-series extensions
- ✅ Production-ready

**Cons**:
- ❌ Requires database server
- ❌ More complex setup
- ❌ Higher resource usage

**Use when**: Production deployment, multiple instances, need reliability

#### 3. **MongoDB (NoSQL Alternative)**

**Best for**: Flexible schema, document storage

**Pros**:
- ✅ Document-based (JSON-like)
- ✅ Flexible schema
- ✅ Easy to scale
- ✅ Good for nested order data

**Cons**:
- ❌ Eventually consistent (not fully ACID)
- ❌ Different query model
- ❌ Requires server

**Use when**: Complex nested data, need flexibility

### Database Schema Recommendations

If implementing a database, consider these tables:

**1. `processed_orders`** - Track processed orders
```sql
- order_id (PK)
- rithum_order_id
- shipstation_order_id
- stream_event_id
- processed_at
- status (processed, failed, pending)
- error_message
- retry_count
- created_at
- updated_at
```

**2. `stream_state`** - Stream position tracking
```sql
- stream_id (PK)
- last_position
- last_event_id
- updated_at
```

**3. `failed_orders`** - Error tracking and retry queue
```sql
- order_id (PK)
- rithum_order_id
- error_type
- error_message
- retry_count
- next_retry_at
- created_at
```

**4. `sync_logs`** - Audit trail (optional)
```sql
- id (PK)
- sync_type
- orders_processed
- orders_failed
- duration_ms
- started_at
- completed_at
```

### Migration Strategy (File → Database)

If moving from file-based to database:

1. **Phase 1**: Add database alongside files
   - Keep `.stream-config.json` for now
   - Start tracking processed orders in DB
   - Dual-write for transition period

2. **Phase 2**: Migrate stream state
   - Move position tracking to database
   - Update code to read from DB
   - Keep file as backup

3. **Phase 3**: Remove file dependency
   - Remove `.stream-config.json` usage
   - Database becomes single source of truth

### Recommendation Matrix

| Requirement | File-Based | SQLite | PostgreSQL |
|------------|------------|--------|------------|
| Single instance | ✅ | ✅ | ✅ |
| Multiple instances | ❌ | ❌ | ✅ |
| Deduplication | ❌ | ✅ | ✅ |
| Error tracking | ❌ | ✅ | ✅ |
| Audit trail | ❌ | ✅ | ✅ |
| Bulk order safety | ⚠️ | ✅ | ✅ |
| Analytics | ❌ | ✅ | ✅ |
| Setup complexity | ✅ Simple | ⚠️ Medium | ❌ Complex |
| Infrastructure | ✅ None | ✅ Minimal | ❌ Requires server |

### Conclusion

**Start with file-based** if:
- Single instance
- Low volume
- Simple requirements
- Rapid prototyping

**Move to SQLite** when you need:
- Order deduplication
- Better error tracking
- Still single instance

**Move to PostgreSQL** when you need:
- Multiple instances
- Production reliability
- Complex queries
- High volume

## Technology Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **HTTP Client**: Axios
- **Scheduling**: node-cron
- **Authentication**: OAuth2 (Rithum), Basic Auth (ShipStation)
- **Storage**: File-based (`.stream-config.json`) - See "Database vs File-Based Storage" section for database options

## Project Structure

```
src/
├── server.js                 # Express app entry point
├── config/
│   ├── rithumConfig.js       # Rithum configuration
│   └── shipstationConfig.js  # ShipStation configuration
├── services/
│   ├── rithumClient.js       # Rithum API client (currently handles all Rithum operations)
│   └── shipstationClient.js  # ShipStation API client
│   # Planned services (not yet implemented):
│   # ├── orderStreamService.js # Order stream management (future separation)
│   # └── orderSyncService.js   # Sync service with cron (future separation)
└── routes/
    ├── rithum.js             # Rithum endpoints
    └── shipstation.js        # ShipStation endpoints & webhooks
```

### Service Architecture & Responsibilities

Currently, the architecture is simpler than described in the structure above. Here's what exists vs. what's planned:

#### Current Implementation (What Exists Now)

**`rithumClient.js`** - Monolithic client that handles:
- **Low-level API communication**: HTTP requests, authentication, retries, error handling
- **Basic Rithum operations**: `fetchOrders()`, `updateOrder()`, `getOrderById()`
- **Stream management**: `createOrderStream()`, `initializeOrderStream()`, `checkForNewOrders()`, `getOrderStreamStatus()`
- **State persistence**: Stream position tracking via `.stream-config.json`

**Current State**: All Rithum-related functionality is in one service.

#### Planned Architecture (Separation of Concerns)

The following services are mentioned in documentation but **not yet implemented**. They represent a better separation of concerns:

**1. `rithumClient.js`** (Would become focused on API calls only)
- **Responsibility**: Low-level HTTP client for Rithum API
- **Functions**:
  - OAuth2 authentication & token management
  - HTTP requests with retry logic
  - Error handling & response parsing
  - Direct API operations: `fetchOrders()`, `updateOrder()`, `getOrderById()`
- **What it does NOT do**: Business logic, stream state management, orchestration

**2. `orderStreamService.js`** (Planned - Stream abstraction layer)
- **Responsibility**: High-level stream operations & state management
- **Functions**:
  - Stream lifecycle: `initialize()`, `getStatus()`, `reset()`
  - Event retrieval: `checkForNewOrders()`, `getEvents()`
  - Position management: Track and persist stream position
  - Stream health monitoring
- **Depends on**: `rithumClient` for actual API calls
- **Benefits**: Cleaner separation, easier testing, reusable stream logic

**3. `orderSyncService.js`** (Planned - Orchestration & scheduling)
- **Responsibility**: Orchestrate the full sync workflow with cron scheduling
- **Functions**:
  - Scheduled polling (using node-cron)
  - Sync workflow: Check stream → Get orders → Transform → Send to ShipStation
  - Error handling & retries at workflow level
  - Metrics & logging
  - Deduplication logic
- **Depends on**: `orderStreamService` (or `rithumClient`), `shipstationClient`
- **Benefits**: Centralized sync logic, easier to test schedules, better error recovery

#### Why Separate Them?

**Current Issues** (with everything in `rithumClient`):
- Mixed responsibilities (API client + business logic)
- Harder to test individual components
- Tight coupling between API calls and stream management

**Benefits of Separation**:
- **Single Responsibility**: Each service has one clear purpose
- **Testability**: Can mock `rithumClient` when testing `orderStreamService`
- **Reusability**: `orderStreamService` could work with different clients
- **Maintainability**: Changes to sync logic don't affect API client
- **Scalability**: Can add features (like multiple streams) more easily

## Security Notes

- Store all credentials in `.env` file (never commit to git)
- Use HTTPS for production webhook URLs
- Monitor logs for unusual activity
- Keep API credentials secure and rotate regularly

---

**Note**: The cron job runs continuously while the server is running. Restarting the server automatically resumes with the configured schedule.

