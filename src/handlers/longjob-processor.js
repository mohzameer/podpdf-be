/**
 * LongJob Processor handler
 * Handles: SQS-triggered processing of long jobs
 * Processes queued jobs, generates PDF, uploads to S3, calls webhook
 */

const logger = require('../utils/logger');
const { wrapHandler } = require('../utils/sentry');
const {
  atomicallyStartProcessing,
  updateJobRecord,
  getJobRecord,
  createAnalyticsRecord,
} = require('../services/jobTracking');
const { generatePDF } = require('../services/pdf');
const { uploadPDF, generateSignedUrl, getExpirationTimestamp } = require('../services/s3');
const { getUserAccount, getPlan, queueCreditDeduction } = require('../services/business');
const { deliverWebhooksForEvent } = require('../services/webhookDelivery');
const { InternalServerError } = require('../utils/errors');

const MAX_LONGJOB_PAGES = parseInt(process.env.MAX_LONGJOB_PAGES || process.env.MAX_PAGES || '100', 10);

/**
 * Trigger webhook for job.processing event
 * @param {string} userId - User ID
 * @param {string} jobId - Job ID
 * @param {object} job - Job record
 * @returns {Promise<{delivered: array, failed: array}>}
 */
async function triggerProcessingWebhook(userId, jobId, job) {
  try {
    const payload = {
      event: 'job.processing',
      job_id: jobId,
      status: 'processing',
      job_type: 'long',
      mode: job.mode || job.input_type,
      created_at: job.created_at,
      started_at: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };

    const result = await deliverWebhooksForEvent(userId, 'job.processing', payload, jobId);
    return result;
  } catch (error) {
    logger.error('Error triggering processing webhook', {
      error: error.message,
      jobId,
      userId,
    });
    return { delivered: [], failed: [] };
  }
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

    // Trigger job.processing webhook
    try {
      const processingWebhooks = await triggerProcessingWebhook(userId, jobId, job);
      if (processingWebhooks.delivered.length > 0) {
        logger.info('Processing webhooks delivered', {
          jobId,
          count: processingWebhooks.delivered.length,
        });
      }
    } catch (error) {
      logger.warn('Error delivering processing webhooks', {
        error: error.message,
        jobId,
      });
      // Continue processing even if webhook fails
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

        // Deliver job.failed webhook
        try {
          const payload = {
            event: 'job.failed',
            job_id: jobId,
            status: 'failed',
            job_type: 'long',
            mode: input_type,
            error_message: `PDF page count (${pageCount}) exceeds maximum allowed pages (${maxPages})`,
            created_at: job.created_at,
            failed_at: new Date().toISOString(),
            timestamp: new Date().toISOString(),
          };

          const webhookResult = await deliverWebhooksForEvent(userId, 'job.failed', payload, jobId);
          
          // Update job record with webhook_ids
          const webhookIds = webhookResult.delivered.map(w => w.webhook_id);
          if (webhookIds.length > 0) {
            await updateJobRecord(jobId, {
              webhook_ids: webhookIds,
              webhook_delivered: webhookResult.delivered.length > 0,
              webhook_delivered_at: webhookResult.delivered.length > 0 ? new Date().toISOString() : null,
            });
          }
        } catch (error) {
          logger.warn('Error delivering failed webhooks', {
            error: error.message,
            jobId,
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

    // Queue credit deduction for ALL users (paid and free)
    // For free plans: amount = 0 (no credit deduction, but still increments PDF count)
    // For paid plans: amount = price_per_pdf (deducts credits and increments PDF count)
    // This ensures total_pdf_count is always updated in one reliable place (credit processor)
    if (user && user.user_id) {
      const deductionAmount = (plan && plan.type === 'paid' && plan.price_per_pdf > 0) ? plan.price_per_pdf : 0;
      
      await queueCreditDeduction(user.user_id, jobId, deductionAmount).catch(error => {
        // Log error but don't fail the request - PDF was already generated
        // If queue fails, PDF is lost but customer not charged (acceptable)
        logger.warn('Failed to queue credit deduction', {
          error: error.message,
          userId: user.user_id,
          jobId,
          deductionAmount,
        });
      });
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

    // Deliver job.completed webhook
    try {
      const payload = {
        event: 'job.completed',
        job_id: jobId,
        status: 'completed',
        job_type: 'long',
        mode: input_type,
        pages,
        truncated: false,
        s3_url: signedUrl,
        s3_url_expires_at: expiresAt,
        created_at: job.created_at,
        completed_at: new Date().toISOString(),
        timestamp: new Date().toISOString(),
      };

      const webhookResult = await deliverWebhooksForEvent(userId, 'job.completed', payload, jobId);
      
      // Update job record with webhook_ids and delivery status
      const webhookIds = webhookResult.delivered.map(w => w.webhook_id);
      if (webhookIds.length > 0) {
        await updateJobRecord(jobId, {
          webhook_ids: webhookIds,
          webhook_delivered: webhookResult.delivered.length > 0,
          webhook_delivered_at: webhookResult.delivered.length > 0 ? new Date().toISOString() : null,
        });
      }

      if (webhookResult.delivered.length > 0) {
        logger.info('Webhooks delivered successfully', {
          jobId,
          deliveredCount: webhookResult.delivered.length,
          failedCount: webhookResult.failed.length,
        });
      }
    } catch (error) {
      logger.warn('Error delivering completed webhooks', {
        error: error.message,
        jobId,
      });
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

        // Deliver job.failed webhook
        try {
          const payload = {
            event: 'job.failed',
            job_id: jobId,
            status: 'failed',
            job_type: 'long',
            mode: job.mode || job.input_type,
            error_message: error.message,
            created_at: job.created_at,
            failed_at: new Date().toISOString(),
            timestamp: new Date().toISOString(),
          };

          const webhookResult = await deliverWebhooksForEvent(userId, 'job.failed', payload, jobId);
          
          // Update job record with webhook_ids
          const webhookIds = webhookResult.delivered.map(w => w.webhook_id);
          if (webhookIds.length > 0) {
            await updateJobRecord(jobId, {
              webhook_ids: webhookIds,
              webhook_delivered: webhookResult.delivered.length > 0,
              webhook_delivered_at: webhookResult.delivered.length > 0 ? new Date().toISOString() : null,
            });
          }
        } catch (webhookError) {
          logger.warn('Error delivering failed webhooks', {
            error: webhookError.message,
            jobId,
          });
        }
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

module.exports = { handler: wrapHandler(handler) };

