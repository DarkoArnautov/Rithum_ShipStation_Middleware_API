# Quick Setup Guide

## Prerequisites Checklist

Before you begin coding, ensure you have:

### Required Information from Client
- [ ] Rithum API credentials (API key or username/password)
- [ ] Rithum base URL
- [ ] ShipStation API key and secret
- [ ] Sample orders from Rithum (2-3 JSON samples)
- [ ] Deployment server details (or local development choice)

---

## Technology Stack

This project uses:

**Technology Stack:**
- **Language**: Node.js (JavaScript)
- **Framework**: Express.js
- **Database**: PostgreSQL
- **Package Manager**: npm or yarn

---

## Step-by-Step Setup

### 1. Initialize Project Structure

```bash
# Create project directory
mkdir rithum-shipstation-middleware
cd rithum-shipstation-middleware

# Initialize Node.js project
npm init -y

# Install dependencies
npm install express axios pg dotenv cors
npm install --save-dev nodemon
```

### 2. Create Project Structure

```
rithum-shipstation-middleware/
├── src/
│   ├── server.js              # Express app entry point
│   ├── config/
│   │   └── database.js        # Database configuration
│   ├── models/
│   │   ├── Order.js           # Order model
│   │   └── Tracking.js        # Tracking model
│   ├── controllers/
│   │   ├── orderController.js # Order logic
│   │   └── webhookController.js
│   ├── services/
│   │   ├── rithumClient.js    # Rithum API client
│   │   ├── shipstationClient.js # ShipStation API client
│   │   └── mapper.js          # Data mapping
│   ├── routes/
│   │   ├── orders.js          # Order routes
│   │   └── webhooks.js        # Webhook routes
│   ├── middleware/
│   │   └── auth.js            # Authentication middleware
│   └── utils/
│       └── logger.js          # Logging utility
├── tests/
│   └── test_basic.js
├── .env.example               # Example environment variables
├── package.json               # Node.js dependencies
├── docker-compose.yml         # For local PostgreSQL
├── Dockerfile                 # For containerization
└── README.md
```

### 3. Create Configuration File

Create `.env.example`:
```env
# Rithum API
RITHUM_API_URL=https://api.rithum.com
RITHUM_API_KEY=your-api-key-here
RITHUM_API_SECRET=your-api-secret-here

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
APP_ENV=development
LOG_LEVEL=INFO
MIDDLEWARE_URL=http://localhost:8000
```

### 4. Start with Basic Express App

Create `src/server.js`:
```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'Rithum-ShipStation Middleware' 
    });
});

app.get('/', (req, res) => {
    res.json({
        message: 'Rithum-ShipStation Middleware API',
        status: 'running'
    });
});

// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
```

Update `package.json` scripts:
```json
{
  "scripts": {
    "start": "node src/server.js",
    "dev": "nodemon src/server.js"
  }
}
```

### 5. Test Basic Setup

```bash
# Run the app in development mode
npm run dev

# Or run in production mode
npm start

# Test in another terminal
curl http://localhost:8000/ping
```

Expected response:
```json
{"status":"ok","service":"Rithum-ShipStation Middleware"}
```

---

## Development Workflow

### Step 1: Rithum API Integration (First)

1. **Get Rithum API credentials from client**
2. **Study Rithum API documentation**
3. **Create Rithum client** (`src/services/rithumClient.js`)
4. **Test connection** - Write a test to fetch sample orders
5. **Parse order data** - Extract needed fields
6. **Store in database** - Save orders for state management

### Step 2: ShipStation Integration

1. **Get ShipStation API credentials**
2. **Create ShipStation client** (`src/services/shipstationClient.js`)
3. **Implement custom store endpoints** (`src/routes/orders.js`)
4. **Map Rithum data to ShipStation format** (`src/services/mapper.js`)
5. **Send orders to ShipStation**
6. **Set up webhooks for tracking**

### Step 3: Testing

1. **Unit tests** - Test individual functions
2. **Integration tests** - Test API calls
3. **End-to-end tests** - Test full flow
4. **Client testing** - Test with real data

### Step 4: Deployment

1. **Set up production server**
2. **Configure environment variables**
3. **Deploy application**
4. **Set up monitoring**
5. **Configure ShipStation store**

---

## Useful Commands

```bash
# Development
npm run dev

# Production
npm start

# Run tests
npm test

# Database migrations (using pg-migrate)
npm run migrate up

# Docker (if using)
docker-compose up -d
docker-compose down
```

---

## Testing with Sample Data

Before getting real API access, you can work with mock data:

Create `src/utils/mockData.js`:
```javascript
// Create src/utils/mockData.js
exports.SAMPLE_RITHUM_ORDER = {
    "id": "RITHUM-12345",
    "order_number": "ORDER-001",
    "customer": {
        "name": "John Doe",
        "email": "john@example.com"
    },
    "shipping_address": {
        "street": "123 Main St",
        "city": "New York",
        "state": "NY",
        "zip": "10001",
        "country": "US"
    },
    "items": [
        {
            "sku": "SKU-001",
            "name": "Product Name",
            "quantity": 2,
            "price": 29.99
        }
    ],
    "total": 59.98,
    "status": "pending",
    "created_at": "2024-01-15T10:30:00Z"
};
```

---

## Checklist for Starting Development

Before you write any integration code:

- [ ] Project structure created
- [ ] Environment variables configured
- [ ] Basic Express app running
- [ ] Database setup (if using)
- [ ] Rithum API credentials obtained
- [ ] ShipStation API credentials obtained
- [ ] Sample data available
- [ ] Client communication channel established

---

## Common Issues & Solutions

### Issue: Rithum API Connection
**Problem**: Can't connect to Rithum API
**Solution**: 
- Verify API credentials
- Check base URL
- Ensure API endpoint is correct
- Check network/firewall rules

### Issue: ShipStation Authentication
**Problem**: ShipStation returns 401 Unauthorized
**Solution**:
- Verify API key and secret
- Check authentication method (Basic Auth)
- Ensure credentials are base64 encoded

### Issue: Data Mapping Errors
**Problem**: ShipStation rejects order format
**Solution**:
- Review ShipStation required fields
- Add validation for required fields
- Handle optional fields properly

---

## Next Steps After Setup

1. ✅ Follow `PROJECT_GUIDE.md` Phase 1
2. ✅ Implement Rithum API client
3. ✅ Fetch and parse orders
4. ✅ Move to ShipStation integration
5. ✅ Test end-to-end flow

---

## Resources

- Express.js Docs: https://expressjs.com/
- Node.js Docs: https://nodejs.org/
- PostgreSQL Docs: https://www.postgresql.org/docs/
- ShipStation API: https://www.shipstation.com/docs/api/
- Rithum Docs: https://knowledge.rithum.com/

**Start with the setup, then follow the PROJECT_GUIDE.md for detailed implementation steps!**

