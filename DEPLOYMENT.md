# Deployment Guide for Render

This guide explains how to deploy the Rithum-ShipStation Middleware API on Render.

## Services Needed

You need **2 services** on Render:

### 1. **Web Service** (Main API Server)
- **Purpose**: Handles webhooks from ShipStation and API endpoints
- **Type**: Select **"Web Service"**
- **Start Command**: `npm start`
- **Port**: 8000 (or set via `PORT` environment variable)

### 2. **Background Worker** (Cron Job for Step 1)
- **Purpose**: Periodically fetches new orders from Rithum and creates them in ShipStation
- **Type**: Select **"Background Worker"**
- **Start Command**: `node cronjob_step1.js`
- **Schedule**: Run periodically (Render Cron Jobs or keep it running)

## Deployment Steps

### Option A: Using Render Blueprint (Recommended)

1. **Push your code to GitHub**
   ```bash
   git add .
   git commit -m "Add Render deployment configuration"
   git push origin main
   ```

2. **In Render Dashboard**:
   - Click "New" → "Blueprint"
   - Connect your GitHub repository
   - Render will auto-detect `render.yaml`
   - Review and deploy

### Option B: Manual Setup

#### 1. Deploy Web Service

1. **In Render Dashboard**:
   - Click "New" → "Web Service"
   - Connect your GitHub repository

2. **Configure**:
   - **Name**: `rithum-shipstation-api`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Starter` (or `Standard`/`Pro` for production)

3. **Environment Variables**:
   Add all variables from your `.env` file:
   ```
   NODE_ENV=production
   PORT=8000
   SHIPSTATION_API_KEY=your_api_key
   SHIPSTATION_BASE_URL=https://api.shipstation.com
   SHIPSTATION_WAREHOUSE_ID=your_warehouse_id (optional)
   SHIPSTATION_SHIP_FROM_NAME=Your Company (optional)
   SHIPSTATION_SHIP_FROM_ADDRESS=123 Main St (optional)
   SHIPSTATION_SHIP_FROM_CITY=City (optional)
   SHIPSTATION_SHIP_FROM_STATE=CA (optional)
   SHIPSTATION_SHIP_FROM_POSTAL=12345 (optional)
   SHIPSTATION_SHIP_FROM_COUNTRY=US (optional)
   SHIPSTATION_SHIP_FROM_PHONE=555-555-5555 (optional)
   RITHUM_API_URL=https://api.dsco.io/api/v3
   RITHUM_CLIENT_ID=your_client_id
   RITHUM_CLIENT_SECRET=your_client_secret
   ```

4. **Deploy**: Click "Create Web Service"

#### 2. Deploy Background Worker (Cron Job)

1. **In Render Dashboard**:
   - Click "New" → "Background Worker"

2. **Configure**:
   - **Name**: `rithum-shipstation-cronjob`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node cronjob_step1.js`
   - **Plan**: `Starter` (or `Standard`/`Pro` for production)

3. **Environment Variables**:
   - Add the **same environment variables** as the Web Service
   - Click "Add Environment Variable" for each one

4. **Cron Schedule** (Optional):
   - Render doesn't have built-in cron for workers, but you can:
     - **Option 1**: Keep the worker running and use `node-cron` in the script
     - **Option 2**: Use Render's Cron Jobs feature (separate service)
     - **Option 3**: Use external cron service (e.g., cron-job.org) to ping your API

5. **Deploy**: Click "Create Background Worker"

## Configure Webhook in ShipStation

After deployment, update your webhook URL:

1. **Get your Render URL**: 
   - Your web service will have a URL like: `https://rithum-shipstation-api.onrender.com`

2. **Update webhook URL**:
   ```bash
   # Update the webhook with your Render URL
   curl -X PUT https://rithum-shipstation-api.onrender.com/api/shipstation/webhooks/38579 \
     -H "Content-Type: application/json" \
     -d '{"url": "https://rithum-shipstation-api.onrender.com/api/shipstation/webhooks/v2"}'
   ```

   Or use the registration script:
   ```bash
   WEBHOOK_URL=https://rithum-shipstation-api.onrender.com/api/shipstation/webhooks/v2 node register_webhook.js
   ```

## Testing

1. **Test Web Service**:
   ```bash
   curl https://your-app.onrender.com/ping
   # Should return: {"status":"ok","service":"Rithum-ShipStation Middleware"}
   ```

2. **Test Webhook Endpoint**:
   ```bash
   curl -X POST https://your-app.onrender.com/api/shipstation/webhooks/v2 \
     -H "Content-Type: application/json" \
     -d '{"event":"fulfillment_shipped_v2","fulfillment":{"shipment_id":"test","tracking_number":"123"}}'
   ```

3. **Check Cron Job Logs**:
   - Go to your Background Worker in Render
   - Check "Logs" tab to see if cronjob_step1.js is running

## Important Notes

1. **Free Tier Limitations**:
   - Render free tier services spin down after 15 minutes of inactivity
   - Web Service: Will wake up when webhook is received
   - Background Worker: May need to be on a paid plan to run continuously

2. **Cron Job Alternatives**:
   - Use Render's Cron Jobs (separate service type)
   - Use external cron service to ping a dedicated endpoint
   - Keep worker running 24/7 (requires paid plan)

3. **Environment Variables**:
   - Never commit `.env` file to Git
   - Add all secrets in Render dashboard
   - Use Render's "Sync" feature to share env vars between services

4. **Health Checks**:
   - Render automatically uses `/ping` endpoint for health checks
   - Ensure your web service is responding

## Troubleshooting

- **Webhook not receiving events**: Check that webhook URL is publicly accessible
- **Cron job not running**: Check worker logs and ensure it's running continuously
- **Environment variables missing**: Ensure all `.env` variables are added in Render dashboard

