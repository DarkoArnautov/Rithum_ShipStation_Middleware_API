/**
 * Step 1 Cron Job for Render - Runs continuously with internal scheduling
 * 
 * This version is designed for Render Background Workers that run continuously.
 * It uses node-cron to schedule the job internally instead of relying on external cron.
 * 
 * Usage on Render:
 *   Start Command: node cronjob_step1_render.js
 * 
 * The script will:
 *   1. Run immediately on startup
 *   2. Then schedule itself to run every hour (configurable via CRON_SCHEDULE env var)
 *   3. Keep the process running to handle scheduled executions
 */
require('dotenv').config();
const cron = require('node-cron');

// Import the main cron job function
const { fetchAndMapOrders } = require('./cronjob_step1');

// Get cron schedule from environment variable (default: every hour at minute 0)
// Format: "0 * * * *" = every hour at minute 0
// Format: "*/30 * * * *" = every 30 minutes
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *';

console.log('📦 Step 1 Cron Job - Render Version\n');
console.log('='.repeat(80) + '\n');
console.log('🔄 Running continuously with internal scheduling');
console.log(`📅 Schedule: ${CRON_SCHEDULE}`);
console.log('   (Every hour at minute 0 by default)\n');
console.log('='.repeat(80) + '\n');

// Run immediately on startup
console.log('🚀 Running initial execution...\n');
fetchAndMapOrders().catch(error => {
    console.error('❌ Initial execution failed:', error.message);
});

// Schedule the job
console.log(`\n⏰ Scheduling cron job with pattern: ${CRON_SCHEDULE}\n`);
cron.schedule(CRON_SCHEDULE, async () => {
    console.log('\n' + '='.repeat(80));
    console.log(`⏰ Scheduled execution at ${new Date().toISOString()}`);
    console.log('='.repeat(80) + '\n');
    
    try {
        await fetchAndMapOrders();
    } catch (error) {
        console.error('❌ Scheduled execution failed:', error.message);
    }
}, {
    timezone: 'UTC'
});

console.log('✅ Cron job scheduled. Process will keep running...\n');
console.log('💡 To stop, press Ctrl+C or kill the process\n');

// Keep the process alive
process.on('SIGINT', () => {
    console.log('\n\n🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n\n🛑 Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

