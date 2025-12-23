/**
 * Health check handler
 * Handles: GET /health
 */

const logger = require('../utils/logger');

/**
 * GET /health - Health check endpoint
 */
async function handler(event) {
  try {
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
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: error.message,
      }),
    };
  }
}

module.exports = { handler };

