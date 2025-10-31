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

### Order Field Mapping

| ShipStation Field | Rithum Field | Notes |
|-------------------|--------------|-------|
| `orderNumber` | `poNumber` | Primary identifier |
| `orderDate` | `consumerOrderDate` | Fallback to `retailerCreateDate` |
| `orderStatus` | `dscoStatus` | Status mapping applied |
| `amountPaid` | `extendedExpectedCostTotal` | Order total |
| `currencyCode` | `"USD"` | Default currency |

### Shipping Address Mapping

| ShipStation | Rithum |
|-------------|--------|
| `name` | `shipping.name` or `shipping.firstName + lastName` |
| `street1` | `shipping.address1` |
| `city` | `shipping.city` |
| `state` | `shipping.state` or `shipping.region` |
| `postalCode` | `shipping.postal` |
| `country` | `shipping.country` |
| `phone` | `shipping.phone` |

### Line Items Mapping

Each Rithum `lineItem` maps to ShipStation `item`:

| ShipStation | Rithum |
|-------------|--------|
| `sku` | `sku` or `partnerSku` |
| `name` | `title` |
| `quantity` | `quantity` or `acceptedQuantity` |
| `unitPrice` | `expectedCost` or `consumerPrice` |

### Order Status Mapping

| Rithum Status | ShipStation Status |
|---------------|-------------------|
| `created` | `awaiting_shipment` |
| `shipment_pending` | `awaiting_shipment` |
| `shipped` | `shipped` |
| `cancelled` | `cancelled` |

**Note**: Rithum order ID is stored in ShipStation's `customField2` for tracking.

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

## Technology Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **HTTP Client**: Axios
- **Scheduling**: node-cron
- **Authentication**: OAuth2 (Rithum), Basic Auth (ShipStation)

## Project Structure

```
src/
├── server.js                 # Express app entry point
├── config/
│   ├── rithumConfig.js       # Rithum configuration
│   └── shipstationConfig.js  # ShipStation configuration
├── services/
│   ├── rithumClient.js       # Rithum API client
│   ├── shipstationClient.js  # ShipStation API client
│   ├── orderStreamService.js # Order stream management
│   └── orderSyncService.js   # Sync service with cron
└── routes/
    ├── rithum.js             # Rithum endpoints
    └── shipstation.js        # ShipStation endpoints & webhooks
```

## Security Notes

- Store all credentials in `.env` file (never commit to git)
- Use HTTPS for production webhook URLs
- Monitor logs for unusual activity
- Keep API credentials secure and rotate regularly

---

**Note**: The cron job runs continuously while the server is running. Restarting the server automatically resumes with the configured schedule.

