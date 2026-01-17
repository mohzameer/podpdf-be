/**
 * Health check handler
 * Handles: GET /health
 */

const logger = require('../utils/logger');
const { wrapHandler } = require('../utils/sentry');

/**
 * GET /health - Health check endpoint
 */
async function handler(event) {
  try {
    // Test error for Sentry monitoring - trigger with ?test-error=true
    const queryParams = event.queryStringParameters || {};
    if (queryParams['test-error'] === 'true') {
      throw new Error('Test error for Sentry monitoring - this is intentional');
    }

    // Basic health check
    const healthStatus = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime_ms: process.uptime() * 1000,
    };

    // TODO: Add DynamoDB connectivity check

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(healthStatus),
    };
  } catch (error) {
    logger.error('Health check error', { error: error.message });
    // Re-throw error so Sentry can capture it
    throw error;
  }
}

module.exports = { handler: wrapHandler(handler) };

