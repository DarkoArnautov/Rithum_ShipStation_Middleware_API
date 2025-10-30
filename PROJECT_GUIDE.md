# Rithum-ShipStation Middleware API - Project Guide

## Project Overview

This project creates a custom integration middleware between **Rithum (DSCO platform)** and **ShipStation**. ShipStation will connect to this middleware as a custom store integration to pull orders and send tracking information back.

**Timeline**: 2 weeks (25-30 hours)
- Week 1: Rithum API integration + data mapping (15-18 hours)
- Week 2: ShipStation endpoint development + testing (10-12 hours)

---

## Prerequisites - Information Needed from Client

Before starting development, you'll need to collect:

### 1. Rithum API Credentials
- Username/Password OR API Key
- Base URL for Rithum API
- API version (if applicable)
- Any authentication method details

### 2. ShipStation Account
- API credentials (API Key + API Secret)
- ShipStation account details
- Test environment access (if available)

### 3. Sample Data
- 2-3 sample orders from Rithum (JSON format preferred)
- Sample shipment data from ShipStation
- Understanding of order statuses in both systems

### 4. Server Requirements
- Where will the middleware be deployed? (AWS, Azure, local server?)
- Domain/URL for the webhook endpoints
- HTTPS certificate availability

---

## Technical Architecture

### System Flow
```
Rithum Orders → Middleware API → ShipStation
ShipStation Tracking → Middleware API → Rithum
```

### Technology Stack
- **Language**: Node.js (JavaScript)
- **Framework**: Express.js
- **Database**: PostgreSQL (for caching order state)
- **Package Manager**: npm or yarn
- **Deployment**: Docker + Cloud hosting
- **Authentication**: API keys for both Rithum and ShipStation

---

## Development Steps

### Phase 1: Rithum API Integration (Week 1, Days 1-3)

#### Step 1.1: Set Up Rithum API Client
- [ ] Create API authentication module for Rithum
- [ ] Implement base API client with retry logic
- [ ] Test connection to Rithum API
- [ ] Document available endpoints

**Deliverables:**
- `src/services/rithumClient.js`
- API connection test script

#### Step 1.2: Fetch Orders from Rithum
- [ ] Implement order fetching endpoint
- [ ] Handle pagination (if Rithum API supports it)
- [ ] Parse and validate order data
- [ ] Store orders in local database for state management

**Key Data Points to Capture:**
- Order ID
- Customer information
- Shipping address
- Product details
- Order status
- Order date

**Deliverables:**
- Order fetching function
- Database schema for orders
- Data validation logic

#### Step 1.3: Map Rithum Data to ShipStation Format
- [ ] Study ShipStation order format (JSON structure)
- [ ] Create mapping function from Rithum → ShipStation
- [ ] Handle edge cases (missing fields, special characters)
- [ ] Test with sample orders

**ShipStation Order Format Reference:**
```json
{
  "orderNumber": "string",
  "orderDate": "datetime",
  "orderStatus": "string",
  "customerUsername": "string",
  "customerEmail": "string",
  "billTo": { /* address object */ },
  "shipTo": { /* address object */ },
  "items": [ /* array of product objects */ ],
  "amountPaid": "number",
  "shippingAmount": "number"
}
```

**Deliverables:**
- Data mapping function
- Unit tests for mapping
- Documentation of field mappings

#### Step 1.4: Implement Order State Management
- [ ] Track which orders have been sent to ShipStation
- [ ] Prevent duplicate order submissions
- [ ] Handle failed submissions with retry logic
- [ ] Implement order status sync

**Deliverables:**
- Order state tracking database table
- State management functions
- Retry mechanism

---

### Phase 2: ShipStation Integration (Week 1, Day 4 - Week 2, Day 2)

#### Step 2.1: Create ShipStation Custom Store Endpoint
According to ShipStation documentation, custom stores need to implement:
- GET `/orders` - List orders
- POST `/orders` - Create orders
- Webhook for order updates

**Key Endpoints to Implement:**
```
GET  /orders            - ShipStation pulls orders
POST /webhooks/sync     - ShipStation syncs order status
GET  /ping              - Health check for ShipStation
```

**Deliverables:**
- API endpoints file
- Authentication middleware for ShipStation
- Request validation

#### Step 2.2: Implement Order Sending to ShipStation
- [ ] Convert Rithum orders to ShipStation format
- [ ] Send orders via ShipStation API
- [ ] Handle API responses and errors
- [ ] Update local order state

**ShipStation API Endpoints:**
- `POST /orders/createorder` - Create a new order
- `GET /orders` - List orders

**Deliverables:**
- ShipStation order creation function
- Error handling and logging
- Response processing

#### Step 2.3: Receive Tracking Information from ShipStation
- [ ] Set up webhook endpoint for ShipStation notifications
- [ ] Parse tracking data from ShipStation webhooks
- [ ] Map tracking data back to Rithum format
- [ ] Update Rithum with tracking information

**ShipStation Webhook Data:**
```json
{
  "resource_url": "...",
  "resource_type": "ORDER_NOTIFY"
}
```

**Deliverables:**
- Webhook endpoint
- Tracking data processing function
- Rithum update function

#### Step 2.4: Implement Rithum Update API Call
- [ ] Create API call to update order in Rithum
- [ ] Send tracking information to Rithum
- [ ] Handle update responses
- [ ] Log update status

**Deliverables:**
- Rithum update API function
- Tracking sync logic
- Update status logging

---

### Phase 3: Testing & Deployment (Week 2, Days 3-5)

#### Step 3.1: Local Testing
- [ ] Test with sample Rithum data
- [ ] Verify ShipStation order creation
- [ ] Test tracking webhook flow
- [ ] Test error scenarios

**Test Cases:**
1. ✅ Normal order flow (Rithum → ShipStation)
2. ✅ Tracking update flow (ShipStation → Rithum)
3. ✅ Duplicate order prevention
4. ✅ Missing data handling
5. ✅ API failure recovery
6. ✅ Rate limiting handling

**Deliverables:**
- Test suite
- Test results documentation
- Bug fixes

#### Step 3.2: Integration Testing with Client
- [ ] Connect to real Rithum account
- [ ] Test with live ShipStation account
- [ ] Verify end-to-end flow
- [ ] Get client approval

**Deliverables:**
- Integration test report
- Client sign-off
- Production credentials

#### Step 3.3: Deployment
- [ ] Set up production server
- [ ] Configure HTTPS
- [ ] Deploy application
- [ ] Configure environment variables
- [ ] Set up monitoring/logging

**Deployment Checklist:**
- [ ] Server provisioned
- [ ] Domain configured
- [ ] SSL certificate installed
- [ ] Environment variables set
- [ ] Database initialized
- [ ] API endpoints accessible
- [ ] Logging configured
- [ ] Monitoring tools installed

**Deliverables:**
- Deployed application
- Production URL
- Deployment documentation

#### Step 3.4: ShipStation Store Configuration
- [ ] Create custom store in ShipStation
- [ ] Configure store URL to middleware
- [ ] Set up authentication
- [ ] Test connection in ShipStation
- [ ] Enable auto-sync

**ShipStation Setup Steps:**
1. Log into ShipStation
2. Go to Settings → Shipping → Store List
3. Click "Add New Store" → "Other" → "Custom Store"
4. Enter middleware URL
5. Configure authentication
6. Test connection

**Deliverables:**
- ShipStation store configured
- Active connection verified
- Auto-sync enabled

---

## Technical Implementation Details

### API Endpoints Structure

```
Base URL: https://your-middleware-domain.com/api

GET  /api/ping                          - Health check
GET  /api/orders                        - ShipStation fetches orders
POST /api/orders                        - Create order in ShipStation
POST /api/webhooks/shipstation          - ShipStation webhook notifications
GET  /api/rithum/sync                   - Manual sync trigger
POST /api/rithum/orders                 - Manually pull orders from Rithum
GET  /api/status                        - Check sync status
```

### Database Schema

```sql
-- Orders table
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    rithum_order_id VARCHAR(255) UNIQUE,
    shipstation_order_id VARCHAR(255),
    order_data JSONB,
    status VARCHAR(50),
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    shipstation_synced BOOLEAN DEFAULT FALSE
);

-- Tracking table
CREATE TABLE tracking (
    id SERIAL PRIMARY KEY,
    order_id INTEGER REFERENCES orders(id),
    tracking_number VARCHAR(255),
    carrier VARCHAR(100),
    shipped_date TIMESTAMP,
    rithum_updated BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP
);

-- Sync logs table
CREATE TABLE sync_logs (
    id SERIAL PRIMARY KEY,
    order_id INTEGER,
    action VARCHAR(50),
    status VARCHAR(50),
    error_message TEXT,
    created_at TIMESTAMP
);
```

### Configuration File (.env)

```env
# Rithum API
RITHUM_API_URL=https://api.rithum.com
RITHUM_API_KEY=your-api-key
RITHUM_API_SECRET=your-api-secret

# ShipStation API
SHIPSTATION_API_URL=https://ssapi.shipstation.com
SHIPSTATION_API_KEY=your-shipstation-key
SHIPSTATION_API_SECRET=your-shipstation-secret

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=rithum_shipstation
DB_USER=postgres
DB_PASSWORD=your_password

# Application
LOG_LEVEL=INFO
```

---

## Security Considerations

1. **API Authentication**: Use API keys for both Rithum and ShipStation
2. **HTTPS**: All endpoints must use HTTPS
3. **Request Validation**: Validate all incoming data
4. **Rate Limiting**: Implement rate limiting for API endpoints
5. **Error Logging**: Don't expose sensitive data in error messages
6. **Credential Storage**: Use environment variables, never hardcode
7. **Database Security**: Use parameterized queries, prevent SQL injection

---

## Error Handling Strategy

### Common Error Scenarios
1. **Rithum API Down**: Retry with exponential backoff
2. **ShipStation API Failure**: Queue retry, log error
3. **Data Validation Failure**: Log issue, notify client
4. **Duplicate Orders**: Skip silently or update existing
5. **Network Timeout**: Implement timeout and retry logic

### Error Logging
- All errors should be logged with timestamp
- Include context (order ID, API endpoint, error type)
- Set up alerts for critical errors

---

## Monitoring & Support

### Health Monitoring
- Set up uptime monitoring (Pingdom, UptimeRobot)
- Monitor API response times
- Track error rates
- Database health checks

### Logging
- API requests/responses
- Order sync status
- Error occurrences
- Performance metrics

### Client Communication
- Daily status updates during development
- Weekly summary reports
- Documentation handoff
- 2 weeks post-launch support included

---

## ShipStation Custom Store Configuration

### Store Details (to be configured in ShipStation)
- **Store Name**: Rithum (DSCO) Integration
- **Webstore URL**: Your middleware URL
- **Store Type**: Custom Store
- **Refresh Token**: Auto-generated
- **Sync Schedule**: Real-time or scheduled

### Field Mappings
Document all field mappings between Rithum and ShipStation formats:
- Order numbers
- Customer information
- Product details
- Shipping addresses
- Order statuses

---

## Deliverables Checklist

### Code
- [x] Rithum API client
- [x] ShipStation API client
- [x] Middleware API endpoints
- [x] Database layer
- [x] Data mapping functions
- [x] Error handling
- [x] Logging system

### Documentation
- [x] API documentation
- [x] Setup instructions
- [x] Configuration guide
- [x] Deployment guide
- [x] Troubleshooting guide

### Testing
- [x] Unit tests
- [x] Integration tests
- [x] End-to-end tests
- [x] Test results report

### Deployment
- [x] Production server setup
- [x] Environment configuration
- [x] ShipStation store configured
- [x] Monitoring tools installed
- [x] SSL certificate active

---

## Post-Launch Support (2 Weeks)

During the 2-week support period, included support covers:
- Bug fixes for any issues discovered
- Configuration adjustments
- Minor data mapping corrections
- Performance optimizations
- Additional documentation if needed

After 2 weeks, hourly rate applies for additional features or support.

---

## Project Timeline Summary

| Week | Day | Task | Hours | Status |
|------|-----|------|-------|--------|
| 1 | 1 | Project setup + Rithum API client | 3-4 | ⏳ Pending |
| 1 | 2 | Rithum order fetching + parsing | 4-5 | ⏳ Pending |
| 1 | 3 | Data mapping + state management | 4-5 | ⏳ Pending |
| 1 | 4 | ShipStation API endpoints | 4-5 | ⏳ Pending |
| 2 | 1 | Tracking webhook implementation | 3-4 | ⏳ Pending |
| 2 | 2 | Rithum update integration | 3-4 | ⏳ Pending |
| 2 | 3 | Testing + bug fixes | 4-5 | ⏳ Pending |
| 2 | 4 | Client integration testing | 2-3 | ⏳ Pending |
| 2 | 5 | Deployment + documentation | 2-3 | ⏳ Pending |

**Total**: 25-30 hours

---

## Next Steps

1. ✅ Review this guide with client
2. ✅ Collect all prerequisites
3. ✅ Set up development environment
4. ✅ Start Phase 1 implementation
5. ✅ Daily progress updates

---

## Resources

- Rithum Integration Guide: https://knowledge.rithum.com/s/article/Integrating-with-the-platform
- ShipStation Custom Store: https://help.shipstation.com/hc/en-us/articles/360025856192-Custom-Store-Development-Guide
- ShipStation API Docs: https://www.shipstation.com/docs/api/

---

## Questions & Support

For questions during development, maintain regular communication with the client. Document any assumptions or decisions made during development.

**This guide serves as the master plan for building the Rithum-ShipStation Middleware API.**

