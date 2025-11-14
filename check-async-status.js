require('dotenv').config();
const RithumClient = require('./src/services/rithumClient');
const { rithumConfig, validateConfig: validateRithumConfig } = require('./src/config/rithumConfig');

/**
 * Check the status of an asynchronous Rithum API request
 * Usage: node check-async-status.js <requestId>
 */

async function checkAsyncRequestStatus(requestId) {
    console.log(`\n🔍 Checking status for requestId: ${requestId}`);
    console.log('='.repeat(80));
    
    try {
        // Validate Rithum config
        validateRithumConfig();
        
        // Create Rithum client
        const rithumClient = new RithumClient(
            rithumConfig.apiUrl,
            rithumConfig.clientId,
            rithumConfig.clientSecret
        );
        
        // Query the order change log for this requestId
        const changeLogResponse = await rithumClient.getOrderChangeLog({
            requestId: requestId
        });
        
        console.log(`\n📊 Overall Status: ${changeLogResponse.status || 'UNKNOWN'}`);
        console.log(`📝 Number of log entries: ${changeLogResponse.logs?.length || 0}`);
        
        if (!changeLogResponse.logs || changeLogResponse.logs.length === 0) {
            console.log('\n⚠️  No logs found for this requestId yet.');
            console.log('   The request may still be processing. Wait a few seconds and try again.');
            return;
        }
        
        console.log('\n' + '='.repeat(80));
        
        // Display each log entry
        changeLogResponse.logs.forEach((log, index) => {
            console.log(`\n📋 Log Entry #${index + 1}:`);
            console.log(`   Date Processed: ${log.dateProcessed}`);
            console.log(`   Status: ${log.status}`);
            console.log(`   Request Method: ${log.requestMethod}`);
            
            // Display payload info
            if (log.payload) {
                console.log(`   Payload:`);
                console.log(`      Type: ${JSON.stringify(log.payload, null, 8).substring(0, 200)}...`);
            }
            
            // Display results (errors/success messages)
            if (log.results && log.results.length > 0) {
                console.log(`\n   📢 Results/Messages:`);
                log.results.forEach((result, rIndex) => {
                    const severity = result.severity || 'info';
                    const code = result.code || 'N/A';
                    const description = Array.isArray(result.description) 
                        ? result.description.join(', ') 
                        : result.description || 'No description';
                    
                    const icon = severity === 'error' ? '❌' : severity === 'warning' ? '⚠️' : 'ℹ️';
                    console.log(`      ${icon} [${severity.toUpperCase()}] ${code}: ${description}`);
                });
            }
            
            // Display error details if status is failure
            if (log.status === 'failure') {
                console.log(`\n   ❌ FAILURE DETECTED`);
                if (log.error) {
                    console.log(`      Error: ${JSON.stringify(log.error, null, 8)}`);
                }
            }
            
            console.log('\n' + '-'.repeat(80));
        });
        
        // Summary
        const successCount = changeLogResponse.logs.filter(l => l.status === 'success').length;
        const failureCount = changeLogResponse.logs.filter(l => l.status === 'failure').length;
        const pendingCount = changeLogResponse.logs.filter(l => l.status === 'pending').length;
        
        console.log(`\n📊 Summary:`);
        console.log(`   ✅ Success: ${successCount}`);
        console.log(`   ❌ Failure: ${failureCount}`);
        console.log(`   ⏳ Pending: ${pendingCount}`);
        console.log(`   📝 Total: ${changeLogResponse.logs.length}`);
        
        if (failureCount > 0) {
            console.log(`\n❌ There were ${failureCount} failure(s). Please review the error messages above.`);
        } else if (pendingCount > 0) {
            console.log(`\n⏳ There are still ${pendingCount} pending request(s). Check back in a few seconds.`);
        } else {
            console.log(`\n✅ All requests processed successfully!`);
        }
        
        console.log('\n' + '='.repeat(80) + '\n');
        
        // Return the full response for programmatic use
        return changeLogResponse;
        
    } catch (error) {
        console.error(`\n❌ Error checking async status:`, error.message);
        if (error.response && error.response.data) {
            console.error(`   Response data:`, JSON.stringify(error.response.data, null, 2));
        }
        throw error;
    }
}

// Run if called directly from command line
if (require.main === module) {
    const requestId = process.argv[2];
    
    if (!requestId) {
        console.error('❌ Error: Please provide a requestId as an argument');
        console.log('\nUsage: node check-async-status.js <requestId>');
        console.log('Example: node check-async-status.js 1823ba54-3d92-4a86-9f3c-420e4d498213');
        process.exit(1);
    }
    
    checkAsyncRequestStatus(requestId)
        .then(() => {
            console.log('✅ Check complete');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Check failed:', error.message);
            process.exit(1);
        });
}

module.exports = { checkAsyncRequestStatus };
