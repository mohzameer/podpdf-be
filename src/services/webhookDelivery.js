/**
 * Webhook Delivery Service
 * Handles webhook delivery with retry logic and history tracking
 */

const https = require('https');
const { putItem, updateItem } = require('./dynamodb');
const { generateULID } = require('../utils/ulid');
const logger = require('../utils/logger');

const WEBHOOK_HISTORY_TABLE = process.env.WEBHOOK_HISTORY_TABLE;
const WEBHOOKS_TABLE = process.env.WEBHOOKS_TABLE;

const MAX_RETRIES = parseInt(process.env.DEFAULT_WEBHOOK_MAX_RETRIES || '3', 10);
const RETRY_DELAYS = (process.env.DEFAULT_WEBHOOK_RETRY_DELAYS || '1000,2000,4000')
  .split(',')
  .map(d => parseInt(d, 10));
const TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '10000', 10);

/**
 * Call webhook endpoint
 * @param {string} webhookUrl - Webhook URL
 * @param {object} payload - Webhook payload
 * @param {object} headers - Additional headers
 * @returns {Promise<{success: boolean, statusCode: number, error: string|null, duration: number}>}
 */
async function callWebhook(webhookUrl, payload, headers = {}) {
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    try {
      const url = new URL(webhookUrl);
      const postData = JSON.stringify(payload);
      const payloadSize = Buffer.byteLength(postData, 'utf8');

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'PodPDF-Webhook/1.0',
          ...headers,
        },
        timeout: TIMEOUT_MS,
      };

      const req = https.request(options, (res) => {
        let responseData = '';
        const statusCode = res.statusCode;

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          const duration = Date.now() - startTime;
          
          if (statusCode >= 200 && statusCode < 300) {
            resolve({
              success: true,
              statusCode,
              error: null,
              duration,
              payloadSize,
            });
          } else {
            resolve({
              success: false,
              statusCode,
              error: `HTTP ${statusCode}`,
              duration,
              payloadSize,
            });
          }
        });
      });

      req.on('error', (error) => {
        const duration = Date.now() - startTime;
        resolve({
          success: false,
          statusCode: 0,
          error: error.message,
          duration,
          payloadSize: Buffer.byteLength(postData, 'utf8'),
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const duration = Date.now() - startTime;
        resolve({
          success: false,
          statusCode: 0,
          error: 'Request timeout',
          duration,
          payloadSize: Buffer.byteLength(postData, 'utf8'),
        });
      });

      req.write(postData);
      req.end();
    } catch (error) {
      const duration = Date.now() - startTime;
      resolve({
        success: false,
        statusCode: 0,
        error: error.message,
        duration,
        payloadSize: 0,
      });
    }
  });
}

/**
 * Check if status code should trigger retry
 * @param {number} statusCode - HTTP status code
 * @returns {boolean} Whether to retry
 */
function shouldRetry(statusCode) {
  // Retry on 5xx errors, 429 (Too Many Requests), and network errors (0)
  return statusCode === 0 || statusCode >= 500 || statusCode === 429;
}

/**
 * Record webhook delivery in history
 * @param {object} deliveryData - Delivery data
 * @returns {Promise<void>}
 */
async function recordDeliveryHistory(deliveryData) {
  try {
    const historyRecord = {
      webhook_id: deliveryData.webhook_id,
      delivery_id: deliveryData.delivery_id,
      user_id: deliveryData.user_id,
      job_id: deliveryData.job_id,
      event_type: deliveryData.event_type,
      url: deliveryData.url,
      status: deliveryData.status,
      status_code: deliveryData.status_code || null,
      error_message: deliveryData.error_message || null,
      retry_count: deliveryData.retry_count || 0,
      delivered_at: deliveryData.delivered_at,
      duration_ms: deliveryData.duration_ms || 0,
      payload_size_bytes: deliveryData.payload_size_bytes || 0,
    };

    await putItem(WEBHOOK_HISTORY_TABLE, historyRecord);
  } catch (error) {
    logger.error('Error recording webhook delivery history', {
      error: error.message,
      deliveryId: deliveryData.delivery_id,
    });
    // Don't throw - history recording is not critical
  }
}

/**
 * Update webhook statistics
 * @param {string} webhookId - Webhook ID
 * @param {boolean} success - Whether delivery was successful
 * @param {string} timestamp - ISO timestamp
 * @returns {Promise<void>}
 */
async function updateWebhookStats(webhookId, success, timestamp) {
  try {
    const updateExpressions = [];
    const expressionAttributeValues = {
      ':timestamp': timestamp,
    };

    if (success) {
      updateExpressions.push('success_count = if_not_exists(success_count, :zero) + :inc');
      updateExpressions.push('last_success_at = :timestamp');
      expressionAttributeValues[':zero'] = 0;
      expressionAttributeValues[':inc'] = 1;
    } else {
      updateExpressions.push('failure_count = if_not_exists(failure_count, :zero) + :inc');
      updateExpressions.push('last_failure_at = :timestamp');
      expressionAttributeValues[':zero'] = 0;
      expressionAttributeValues[':inc'] = 1;
    }

    updateExpressions.push('last_triggered_at = :timestamp');

    const updateExpression = 'SET ' + updateExpressions.join(', ');

    await updateItem(
      WEBHOOKS_TABLE,
      { webhook_id: webhookId },
      updateExpression,
      expressionAttributeValues
    );
  } catch (error) {
    logger.error('Error updating webhook stats', {
      error: error.message,
      webhookId,
    });
    // Don't throw - stats update is not critical
  }
}

/**
 * Deliver webhook with retry logic
 * @param {object} webhook - Webhook configuration
 * @param {object} payload - Webhook payload
 * @param {string} eventType - Event type
 * @param {string} jobId - Job ID
 * @param {string} userId - User ID
 * @returns {Promise<{delivered: boolean, retryCount: number, deliveryId: string}>}
 */
async function deliverWebhook(webhook, payload, eventType, jobId, userId) {
  const deliveryId = generateULID();
  const webhookUrl = webhook.url;
  let retryCount = 0;
  let finalSuccess = false;
  let finalStatusCode = 0;
  let finalError = null;
  let finalDuration = 0;
  let finalPayloadSize = 0;

  // Add standard headers
  const headers = {
    'X-Webhook-Event': eventType,
    'X-Webhook-Id': webhook.webhook_id,
    'X-Webhook-Delivery-Id': deliveryId,
    'X-Webhook-Timestamp': payload.timestamp || new Date().toISOString(),
  };

  // Add event field to payload if not present
  if (!payload.event) {
    payload.event = eventType;
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await callWebhook(webhookUrl, payload, headers);
    finalStatusCode = result.statusCode;
    finalError = result.error;
    finalDuration = result.duration;
    finalPayloadSize = result.payloadSize;

    // Record this attempt in history
    const deliveredAt = new Date().toISOString();
    await recordDeliveryHistory({
      webhook_id: webhook.webhook_id,
      delivery_id: `${deliveryId}-${attempt}`,
      user_id: userId,
      job_id: jobId,
      event_type: eventType,
      url: webhookUrl,
      status: result.success ? 'success' : (result.statusCode === 0 ? 'timeout' : 'failed'),
      status_code: result.statusCode || null,
      error_message: result.error || null,
      retry_count: attempt,
      delivered_at: deliveredAt,
      duration_ms: result.duration,
      payload_size_bytes: result.payloadSize,
    });

    if (result.success) {
      finalSuccess = true;
      retryCount = attempt;
      break;
    }

    // Check if we should retry
    if (attempt < MAX_RETRIES && shouldRetry(result.statusCode)) {
      const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
      await new Promise((resolve) => setTimeout(resolve, delay));
      retryCount = attempt + 1;
    } else {
      // Don't retry (client error or max retries reached)
      retryCount = attempt;
      break;
    }
  }

  // Update webhook statistics
  const timestamp = new Date().toISOString();
  await updateWebhookStats(webhook.webhook_id, finalSuccess, timestamp);

  return {
    delivered: finalSuccess,
    retryCount,
    deliveryId,
    statusCode: finalStatusCode,
    error: finalError,
    duration: finalDuration,
  };
}

/**
 * Deliver webhooks for an event
 * @param {string} userId - User ID
 * @param {string} eventType - Event type
 * @param {object} payload - Webhook payload
 * @param {string} jobId - Job ID
 * @returns {Promise<{delivered: array, failed: array}>}
 */
async function deliverWebhooksForEvent(userId, eventType, payload, jobId) {
  const { getActiveWebhooksForEvent } = require('./webhook');
  
  try {
    const webhooks = await getActiveWebhooksForEvent(userId, eventType);
    
    if (webhooks.length === 0) {
      return { delivered: [], failed: [] };
    }

    const results = await Promise.allSettled(
      webhooks.map(webhook => deliverWebhook(webhook, payload, eventType, jobId, userId))
    );

    const delivered = [];
    const failed = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.delivered) {
        delivered.push({
          webhook_id: webhooks[index].webhook_id,
          delivery_id: result.value.deliveryId,
        });
      } else {
        failed.push({
          webhook_id: webhooks[index].webhook_id,
          error: result.status === 'rejected' ? result.reason?.message : 'Delivery failed',
        });
      }
    });

    return { delivered, failed };
  } catch (error) {
    logger.error('Error delivering webhooks for event', {
      error: error.message,
      userId,
      eventType,
      jobId,
    });
    return { delivered: [], failed: [] };
  }
}

/**
 * Get webhook history for a webhook
 * @param {string} webhookId - Webhook ID
 * @param {object} filters - Filters (status, event_type, limit, next_token)
 * @returns {Promise<{history: array, count: number, next_token: string|null}>}
 */
async function getWebhookHistory(webhookId, filters = {}) {
  try {
    const { query } = require('./dynamodb');
    
    const statusFilter = filters.status;
    const eventTypeFilter = filters.event_type;
    const limit = Math.min(filters.limit || 50, 100);
    const nextToken = filters.next_token;

    // Query by webhook_id (partition key)
    const result = await query(
      WEBHOOK_HISTORY_TABLE,
      'webhook_id = :webhook_id',
      { ':webhook_id': webhookId },
      null, // Primary index
      limit,
      nextToken ? JSON.parse(Buffer.from(nextToken, 'base64').toString()) : null
    );

    let history = result.Items || [];

    // Apply filters
    if (statusFilter) {
      history = history.filter(h => h.status === statusFilter);
    }

    if (eventTypeFilter) {
      history = history.filter(h => h.event_type === eventTypeFilter);
    }

    // Sort by delivered_at descending (most recent first)
    history.sort((a, b) => {
      if (a.delivered_at > b.delivered_at) return -1;
      if (a.delivered_at < b.delivered_at) return 1;
      return 0;
    });

    // Remove internal fields from response
    history = history.map(({ webhook_id, user_id, ...rest }) => rest);

    const responseNextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return {
      history,
      count: history.length,
      next_token: responseNextToken,
    };
  } catch (error) {
    logger.error('Error getting webhook history', {
      error: error.message,
      webhookId,
    });
    throw error;
  }
}

/**
 * Get webhook history for a job
 * @param {string} jobId - Job ID
 * @param {object} filters - Filters (status, event_type, limit, next_token)
 * @returns {Promise<{history: array, count: number, next_token: string|null}>}
 */
async function getWebhookHistoryByJobId(jobId, filters = {}) {
  try {
    const { query } = require('./dynamodb');
    
    const statusFilter = filters.status;
    const eventTypeFilter = filters.event_type;
    const limit = Math.min(filters.limit || 50, 100);
    const nextToken = filters.next_token;

    // Query by job_id using JobIdIndex
    const result = await query(
      WEBHOOK_HISTORY_TABLE,
      'job_id = :job_id',
      { ':job_id': jobId },
      'JobIdIndex',
      limit,
      nextToken ? JSON.parse(Buffer.from(nextToken, 'base64').toString()) : null
    );

    let history = result.Items || [];

    // Apply filters
    if (statusFilter) {
      history = history.filter(h => h.status === statusFilter);
    }

    if (eventTypeFilter) {
      history = history.filter(h => h.event_type === eventTypeFilter);
    }

    // Sort by delivered_at descending (most recent first)
    history.sort((a, b) => {
      if (a.delivered_at > b.delivered_at) return -1;
      if (a.delivered_at < b.delivered_at) return 1;
      return 0;
    });

    // Remove internal fields from response
    history = history.map(({ webhook_id, user_id, ...rest }) => rest);

    const responseNextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return {
      history,
      count: history.length,
      next_token: responseNextToken,
    };
  } catch (error) {
    logger.error('Error getting webhook history by job ID', {
      error: error.message,
      jobId,
    });
    throw error;
  }
}

module.exports = {
  deliverWebhook,
  deliverWebhooksForEvent,
  getWebhookHistory,
  getWebhookHistoryByJobId,
  callWebhook,
  shouldRetry,
};

