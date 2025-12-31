/**
 * LongJob Processor handler
 * Handles: SQS-triggered processing of long jobs
 * Processes queued jobs, generates PDF, uploads to S3, calls webhook
 */

const https = require('https');
const logger = require('../utils/logger');
const {
  atomicallyStartProcessing,
  updateJobRecord,
  getJobRecord,
  createAnalyticsRecord,
} = require('../services/jobTracking');
const { generatePDF } = require('../services/pdf');
const { uploadPDF, generateSignedUrl, getExpirationTimestamp } = require('../services/s3');
const { incrementPdfCount, getUserAccount, getPlan } = require('../services/business');
const { InternalServerError } = require('../utils/errors');

const MAX_WEBHOOK_RETRIES = 3;
const WEBHOOK_RETRY_DELAYS = [1000, 2000, 4000]; // 1s, 2s, 4s
const MAX_LONGJOB_PAGES = parseInt(process.env.MAX_LONGJOB_PAGES || process.env.MAX_PAGES || '100', 10);

/**
 * Call webhook with job details
 * @param {string} webhookUrl - Webhook URL
 * @param {object} payload - Webhook payload
 * @returns {Promise<{success: boolean, statusCode: number, error: string|null}>}
 */
async function callWebhook(webhookUrl, payload) {
  return new Promise((resolve) => {
    try {
      const url = new URL(webhookUrl);
      const postData = JSON.stringify(payload);

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 10000, // 10 second timeout
      };

      const req = https.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              success: true,
              statusCode: res.statusCode,
              error: null,
            });
          } else {
            resolve({
              success: false,
              statusCode: res.statusCode,
              error: `HTTP ${res.statusCode}`,
            });
          }
        });
      });

      req.on('error', (error) => {
        resolve({
          success: false,
          statusCode: 0,
          error: error.message,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          statusCode: 0,
          error: 'Request timeout',
        });
      });

      req.write(postData);
      req.end();
    } catch (error) {
      resolve({
        success: false,
        statusCode: 0,
        error: error.message,
      });
    }
  });
}

/**
 * Deliver webhook with retry logic
 * @param {string} webhookUrl - Webhook URL
 * @param {object} payload - Webhook payload
 * @returns {Promise<{delivered: boolean, retryCount: number, retryLog: array}>}
 */
async function deliverWebhook(webhookUrl, payload) {
  const retryLog = [];
  let retryCount = 0;

  for (let attempt = 0; attempt <= MAX_WEBHOOK_RETRIES; attempt++) {
    const attemptStartTime = Date.now();
    const result = await callWebhook(webhookUrl, payload);
    const attemptDuration = Date.now() - attemptStartTime;

    retryLog.push({
      attempt: attempt + 1,
      timestamp: new Date().toISOString(),
      success: result.success,
      statusCode: result.statusCode,
      error: result.error,
      duration_ms: attemptDuration,
    });

    if (result.success) {
      return {
        delivered: true,
        retryCount: attempt,
        retryLog,
      };
    }

    // If not the last attempt, wait before retrying
    if (attempt < MAX_WEBHOOK_RETRIES) {
      retryCount = attempt + 1;
      const delay = WEBHOOK_RETRY_DELAYS[attempt];
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  return {
    delivered: false,
    retryCount: MAX_WEBHOOK_RETRIES,
    retryLog,
  };
}

/**
 * Process a single SQS message
 * @param {object} record - SQS record
 */
async function processMessage(record) {
  const startTime = Date.now();
  let jobId = null;
  let userSub = null;

  try {
    // Parse SQS message body
    const messageBody = JSON.parse(record.body);
    jobId = messageBody.job_id;
    const userId = messageBody.user_id || messageBody.user_sub; // Support both for migration
    userSub = messageBody.user_sub; // Keep for getUserAccount lookup

    logger.info('Processing long job', {
      jobId,
      userId,
      userSub,
      messageId: record.messageId,
    });

    // Deduplication check: atomically start processing
    const { success, job } = await atomicallyStartProcessing(jobId);

    if (!success) {
      if (job && (job.status === 'completed' || job.status === 'processing')) {
        logger.info('Job already processed or being processed, skipping', {
          jobId,
          status: job.status,
        });
        return; // Skip duplicate message
      }
      // Job doesn't exist or other error
      logger.warn('Could not start processing job', {
        jobId,
        jobExists: !!job,
      });
      return;
    }

    // Extract job details from message
    const { input_type, content, options, webhook_url } = messageBody;

    // Generate PDF
    let pdfResult;
    try {
      pdfResult = await generatePDF(content, input_type, options || {}, MAX_LONGJOB_PAGES);
    } catch (error) {
      // Check for page limit exceeded error
      if (error.message && error.message.startsWith('PAGE_LIMIT_EXCEEDED:')) {
        const [, pageCount, maxPages] = error.message.split(':');
        await updateJobRecord(jobId, {
          status: 'failed',
          error_message: `PDF page count (${pageCount}) exceeds maximum allowed pages (${maxPages})`,
        });

        await createAnalyticsRecord({
          jobId,
          jobType: 'long',
          mode: input_type,
          status: 'failed',
          jobDuration: Date.now() - startTime,
        });

        // Deliver webhook with error if configured
        if (webhook_url) {
          await deliverWebhook(webhook_url, {
            job_id: jobId,
            status: 'failed',
            error_message: `PDF page count (${pageCount}) exceeds maximum allowed pages (${maxPages})`,
            created_at: job.created_at,
            failed_at: new Date().toISOString(),
          });
        }

        logger.error('PDF generation failed - page limit exceeded', {
          jobId,
          pageCount: parseInt(pageCount, 10),
          maxPages: parseInt(maxPages, 10),
        });
        return; // Exit early, job marked as failed
      }
      throw error;
    }
    
    const { pdf, pages } = pdfResult;

    // Upload PDF to S3
    const s3Key = await uploadPDF(jobId, pdf);

    // Generate signed URL (1 hour expiry)
    const signedUrl = await generateSignedUrl(s3Key, 3600);
    const expiresAt = getExpirationTimestamp(3600);

    // Get user account and plan for PDF count increment and billing
    const user = await getUserAccount(userSub);
    let plan = null;
    if (user) {
      const planId = user.plan_id || 'free-basic';
      plan = await getPlan(planId);
    }

    // Update job record with completion
    await updateJobRecord(jobId, {
      status: 'completed',
      pages,
      truncated: false,
      s3_key: s3Key,
      s3_url: signedUrl,
      s3_url_expires_at: expiresAt,
    });

    // Increment PDF count and track billing
    if (user && user.user_id) {
      await incrementPdfCount(userSub, user.user_id, plan);
    }

    // Create analytics record
    await createAnalyticsRecord({
      jobId,
      jobType: 'long',
      mode: input_type,
      pages,
      status: 'success',
      jobDuration: Date.now() - startTime,
    });

    // Deliver webhook if configured
    if (webhook_url) {
      const webhookPayload = {
        job_id: jobId,
        status: 'completed',
        s3_url: signedUrl,
        s3_url_expires_at: expiresAt,
        pages,
        mode: input_type,
        truncated: false,
        created_at: job.created_at,
        completed_at: new Date().toISOString(),
      };

      const webhookResult = await deliverWebhook(webhook_url, webhookPayload);

      // Update job record with webhook delivery status
      await updateJobRecord(jobId, {
        webhook_delivered: webhookResult.delivered,
        webhook_delivered_at: webhookResult.delivered
          ? new Date().toISOString()
          : null,
        webhook_retry_count: webhookResult.retryCount,
        webhook_retry_log: webhookResult.retryLog,
      });

      // Update analytics with webhook retry count
      await createAnalyticsRecord({
        jobId,
        jobType: 'long',
        mode: input_type,
        pages,
        status: 'success',
        jobDuration: Date.now() - startTime,
        webhookRetryCount: webhookResult.retryCount,
      });

      if (!webhookResult.delivered) {
        logger.warn('Webhook delivery failed after all retries', {
          jobId,
          webhookUrl: webhook_url,
          retryCount: webhookResult.retryCount,
        });
      } else {
        logger.info('Webhook delivered successfully', {
          jobId,
          webhookUrl: webhook_url,
          retryCount: webhookResult.retryCount,
        });
      }
    }

    logger.info('Long job processed successfully', {
      jobId,
      pages,
      truncated: false,
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    logger.error('Error processing long job', {
      error: error.message,
      stack: error.stack,
      jobId,
      userSub,
    });

    // Update job record with error
    if (jobId) {
      try {
        await updateJobRecord(jobId, {
          status: 'failed',
          error_message: error.message,
        });

        await createAnalyticsRecord({
          jobId,
          jobType: 'long',
          status: 'failure',
          jobDuration: Date.now() - startTime,
        });
      } catch (updateError) {
        logger.error('Error updating job record on failure', {
          error: updateError.message,
        });
      }
    }

    // Re-throw to trigger SQS retry
    throw error;
  }
}

/**
 * SQS event handler
 * Processes multiple SQS records
 */
async function handler(event) {
  try {
    const records = event.Records || [];

    logger.info('LongJob processor invoked', {
      recordCount: records.length,
    });

    // Process each record
    const promises = records.map((record) => processMessage(record));

    // Wait for all to complete (or fail)
    await Promise.allSettled(promises);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Processed ${records.length} job(s)`,
      }),
    };
  } catch (error) {
    logger.error('LongJob processor handler error', {
      error: error.message,
      stack: error.stack,
    });
    throw error; // Let Lambda handle retry
  }
}

module.exports = { handler };

