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
 *   2. Then schedule itself to run every 5 minutes (configurable via CRON_SCHEDULE env var)
 *   3. Keep the process running to handle scheduled executions
 */
require('dotenv').config();

// Import the main cron job function
const { fetchAndMapOrders } = require('./cronjob_step1');

// Get interval from environment variable (default: every 5 minutes)
// Format: "*/5 * * * *" = every 5 minutes (300000 ms)
// Format: "*/30 * * * *" = every 30 minutes (1800000 ms)
// Format: "0 * * * *" = every hour (3600000 ms)
// Or use INTERVAL_MS directly: "300000" = 5 minutes
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/5 * * * *';
const INTERVAL_MS = process.env.INTERVAL_MS 
    ? parseInt(process.env.INTERVAL_MS) 
    : (CRON_SCHEDULE.includes('*/') 
        ? parseInt(CRON_SCHEDULE.match(/\*\/(\d+)/)?.[1] || '5') * 60 * 1000
        : 60 * 60 * 1000); // Default to 1 hour if pattern not recognized

// Flag to prevent overlapping executions
let isRunning = false;

console.log('📦 Step 1 Cron Job - Render Version\n');
console.log('='.repeat(80) + '\n');
console.log('🔄 Running continuously with internal scheduling');
console.log(`📅 Schedule pattern: ${CRON_SCHEDULE}`);
console.log(`⏱️  Interval: ${INTERVAL_MS / 1000} seconds (${INTERVAL_MS / 60000} minutes)\n`);
console.log('='.repeat(80) + '\n');

// Wrapper function to prevent overlapping executions and add logging
async function runJobSafely(label = 'Execution') {
    if (isRunning) {
        console.log(`⏭️  [${new Date().toISOString()}] ${label}: Previous execution still running, skipping...`);
        return;
    }
    
    isRunning = true;
    const startTime = Date.now();
    console.log(`🚀 [${new Date().toISOString()}] ${label}: Starting...`);
    
    try {
        await fetchAndMapOrders();
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`✅ [${new Date().toISOString()}] ${label}: Completed in ${duration} seconds\n`);
    } catch (error) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`❌ [${new Date().toISOString()}] ${label}: Failed after ${duration} seconds:`, error.message);
    } finally {
        isRunning = false;
    }
}

// Run immediately on startup
console.log('🚀 Running initial execution...\n');
runJobSafely('Initial').catch(error => {
    console.error('❌ Initial execution failed:', error.message);
    isRunning = false;
});

// Schedule the job using setInterval (more reliable than node-cron)
console.log(`\n⏰ Scheduling job to run every ${INTERVAL_MS / 1000} seconds (${INTERVAL_MS / 60000} minutes)...\n`);

// Track next execution time
let nextExecutionTime = new Date(Date.now() + INTERVAL_MS);

// Calculate next execution time
const getNextExecutionTime = () => {
    return nextExecutionTime;
};

// Schedule using setInterval
const scheduledInterval = setInterval(async () => {
    const executionStartTime = new Date();
    nextExecutionTime = new Date(executionStartTime.getTime() + INTERVAL_MS);
    
    console.log('\n' + '='.repeat(80));
    console.log(`⏰⏰⏰ SCHEDULED EXECUTION TRIGGERED ⏰⏰⏰`);
    console.log(`⏰ Time: ${executionStartTime.toISOString()}`);
    console.log(`⏰ Calling fetchAndMapOrders() now...`);
    console.log('='.repeat(80) + '\n');
    
    try {
        await runJobSafely('Scheduled');
        
        console.log('\n' + '='.repeat(80));
        console.log(`✅ Scheduled execution finished at ${new Date().toISOString()}`);
        console.log(`📅 Next execution: ${nextExecutionTime.toISOString()}`);
        console.log('='.repeat(80) + '\n');
    } catch (error) {
        console.error('\n' + '='.repeat(80));
        console.error(`❌ Scheduled execution error: ${error.message}`);
        console.error('='.repeat(80) + '\n');
    }
}, INTERVAL_MS);

console.log(`✅ Job scheduled successfully`);
console.log(`📅 Next scheduled execution: ${nextExecutionTime.toISOString()}\n`);

console.log('✅ Cron job scheduled. Process will keep running...\n');
console.log('💡 To stop, press Ctrl+C or kill the process\n');

// Add a heartbeat log every minute to show the process is alive
const heartbeatInterval = setInterval(() => {
    const now = new Date();
    const nextExec = getNextExecutionTime();
    const timeUntilNext = Math.round((nextExec.getTime() - now.getTime()) / 1000);
    console.log(`💓 [${now.toISOString()}] Process alive. Next execution in ${timeUntilNext} seconds (at ${nextExec.toISOString()})`);
}, 60000); // Every minute

// Keep the process alive and cleanup on shutdown
process.on('SIGINT', () => {
    console.log('\n\n🛑 Received SIGINT, shutting down gracefully...');
    clearInterval(scheduledInterval);
    clearInterval(heartbeatInterval);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n\n🛑 Received SIGTERM, shutting down gracefully...');
    clearInterval(scheduledInterval);
    clearInterval(heartbeatInterval);
    process.exit(0);
});
