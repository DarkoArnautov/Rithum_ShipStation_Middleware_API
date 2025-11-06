# Render Deployment Checklist

## ✅ Step 1: Push Code to GitHub

**If you haven't pushed yet:**
```bash
git push origin main
```

If you get authentication errors, you may need to:
- Use SSH instead of HTTPS: `git remote set-url origin git@github.com:DarkoArnautov/Rithum_ShipStation_Middleware_API.git`
- Or authenticate with GitHub: `gh auth login`

---

## ✅ Step 2: Deploy on Render

### Option A: Using Render Blueprint (Recommended - Easiest)

1. **Go to Render Dashboard**: https://dashboard.render.com
2. **Click "New"** → **"Blueprint"**
3. **Connect GitHub Repository**:
   - Click "Connect GitHub" (if not already connected)
   - Select your repository: `DarkoArnautov/Rithum_ShipStation_Middleware_API`
4. **Review Configuration**:
   - Render will auto-detect `render.yaml`
   - You'll see 2 services:
     - **Web Service** (`rithum-shipstation-api`)
     - **Background Worker** (`rithum-shipstation-cronjob`)
5. **Click "Apply"** to create both services

### Option B: Manual Setup (If Blueprint doesn't work)

#### Create Web Service:

1. **Click "New"** → **"Web Service"**
2. **Connect Repository**: Select `Rithum_ShipStation_Middleware_API`
3. **Configure**:
   - **Name**: `rithum-shipstation-api`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Starter` (free tier) or `Standard`/`Pro` (paid)
4. **Click "Create Web Service"**

#### Create Background Worker:

1. **Click "New"** → **"Background Worker"**
2. **Connect Repository**: Select the same repository
3. **Configure**:
   - **Name**: `rithum-shipstation-cronjob`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node cronjob_step1_render.js`
   - **Plan**: `Starter` (free tier) or `Standard`/`Pro` (paid - required for 24/7 operation)
4. **Click "Create Background Worker"**

---

## ✅ Step 3: Configure Environment Variables

You need to add **ALL** environment variables from your `.env` file to BOTH services.

### For Web Service:

1. Go to your Web Service in Render dashboard
2. Click **"Environment"** tab
3. Click **"Add Environment Variable"** for each:

```
NODE_ENV=production
PORT=8000
SHIPSTATION_API_KEY=your_api_key_here
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
RITHUM_CLIENT_ID=your_client_id_here
RITHUM_CLIENT_SECRET=your_client_secret_here
```

**Optional for Cron Job Schedule:**
```
CRON_SCHEDULE=0 * * * *  (every hour at minute 0)
```

### For Background Worker:

1. Go to your Background Worker in Render dashboard
2. Click **"Environment"** tab
3. Add the **SAME** environment variables as above

**💡 Tip**: You can use Render's "Sync" feature to share environment variables between services:
- Click "Sync" next to an environment variable
- Select the other service to sync to

---

## ✅ Step 4: Wait for Deployment

1. **Monitor Build Logs**: 
   - Click on each service
   - Check "Logs" tab
   - Wait for "Build successful" and "Service is live"

2. **Get Your Web Service URL**:
   - After deployment, your Web Service will have a URL like:
   - `https://rithum-shipstation-api.onrender.com`
   - Or custom domain if you configured one

---

## ✅ Step 5: Update Webhook in ShipStation

After deployment, update your webhook URL to point to your Render service.

### Option 1: Use the Registration Script (Local)

```bash
# Set your Render URL
WEBHOOK_URL=https://rithum-shipstation-api.onrender.com/api/shipstation/webhooks/v2 node register_webhook.js
```

### Option 2: Update via API

```bash
# Replace WEBHOOK_ID with your webhook ID (e.g., 38579)
curl -X PUT https://rithum-shipstation-api.onrender.com/api/shipstation/webhooks/WEBHOOK_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic YOUR_SHIPSTATION_API_KEY" \
  -d '{"url": "https://rithum-shipstation-api.onrender.com/api/shipstation/webhooks/v2"}'
```

### Option 3: Update in ShipStation Dashboard

1. Log in to ShipStation
2. Go to **Settings** → **Integrations** → **Webhooks**
3. Find your webhook (ID: 38579)
4. Edit the URL to: `https://rithum-shipstation-api.onrender.com/api/shipstation/webhooks/v2`
5. Save

---

## ✅ Step 6: Test Deployment

### Test Web Service:

```bash
# Health check
curl https://rithum-shipstation-api.onrender.com/ping

# Should return: {"status":"ok","service":"Rithum-ShipStation Middleware"}
```

### Test Webhook Endpoint:

```bash
curl -X POST https://rithum-shipstation-api.onrender.com/api/shipstation/webhooks/v2 \
  -H "Content-Type: application/json" \
  -d '{
    "event": "fulfillment_shipped_v2",
    "fulfillment": {
      "shipment_id": "test",
      "tracking_number": "123456789"
    }
  }'
```

### Check Cron Job Logs:

1. Go to your Background Worker in Render
2. Click **"Logs"** tab
3. You should see:
   - `📦 Step 1 Cron Job - Render Version`
   - Initial execution running
   - Scheduled job configured

---

## ⚠️ Important Notes

### Free Tier Limitations:

- **Web Service**: Spins down after 15 minutes of inactivity
  - ✅ Will wake up when webhook is received
  - ✅ First request may take 30-60 seconds (cold start)
  
- **Background Worker**: 
  - ⚠️ Free tier may not run 24/7 continuously
  - 💡 Consider upgrading to paid plan for production use
  - Or use external cron service (e.g., cron-job.org) to ping your API

### Paid Plans:

- **Starter**: $7/month per service
- **Standard**: $25/month per service  
- **Pro**: $85/month per service

For production, consider:
- **Web Service**: Starter or Standard
- **Background Worker**: Standard (for 24/7 operation)

---

## 🐛 Troubleshooting

### Webhook not receiving events:
- ✅ Check that webhook URL is publicly accessible
- ✅ Check Render logs for errors
- ✅ Verify webhook is "Active" in ShipStation
- ✅ Test webhook endpoint manually with curl

### Cron job not running:
- ✅ Check Background Worker logs
- ✅ Verify environment variables are set
- ✅ Check if worker is running (free tier may spin down)
- ✅ Consider upgrading to paid plan

### Environment variables not working:
- ✅ Ensure all variables are added to BOTH services
- ✅ Check for typos in variable names
- ✅ Verify values are correct (no extra spaces)
- ✅ Use "Sync" feature to share between services

### Build fails:
- ✅ Check build logs for errors
- ✅ Verify `package.json` is correct
- ✅ Ensure all dependencies are listed
- ✅ Check Node.js version compatibility

---

## 📞 Need Help?

- **Render Docs**: https://render.com/docs
- **Render Support**: https://render.com/support
- **Check Logs**: Always check service logs first for errors

---

## ✅ Deployment Checklist

- [ ] Code pushed to GitHub
- [ ] Web Service created on Render
- [ ] Background Worker created on Render
- [ ] All environment variables added to Web Service
- [ ] All environment variables added to Background Worker
- [ ] Services deployed successfully
- [ ] Webhook URL updated in ShipStation
- [ ] Health check endpoint tested
- [ ] Webhook endpoint tested
- [ ] Cron job logs checked

---

**Good luck with your deployment! 🚀**



