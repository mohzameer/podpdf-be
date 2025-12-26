/**
 * LongJob handler
 * Handles: POST /longjob
 * Asynchronous PDF generation with queueing, S3 storage, and webhook notifications
 */

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const logger = require('../utils/logger');
const { extractUserSub } = require('../middleware/auth');
const { validateRequestBody, validateWebhookUrl } = require('../services/validation');
const {
  validateUserAndPlan,
  checkRateLimit,
  checkQuota,
  getUserAccount,
} = require('../services/business');
const {
  generateJobId,
  createJobRecord,
} = require('../services/jobTracking');
const { generatePDF } = require('../services/pdf');
const { BadRequest, Forbidden, InternalServerError } = require('../utils/errors');

const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'eu-central-1' });
const QUEUE_URL = process.env.LONGJOB_QUEUE_URL;

/**
 * POST /longjob - Queue job for asynchronous processing
 */
async function handler(event) {
  try {
    // Extract user sub from JWT
    const userSub = await extractUserSub(event);
    if (!userSub) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid JWT token',
          },
        }),
      };
    }

    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return BadRequest.MISSING_INPUT_TYPE();
    }

    // Validate request body
    const validation = validateRequestBody(body);
    if (!validation.isValid) {
      return validation.error;
    }

    const { inputType, content, options, webhookUrl } = validation.data;

    // Validate webhook URL if provided
    if (webhookUrl) {
      const webhookValidation = validateWebhookUrl(webhookUrl);
      if (!webhookValidation.isValid) {
        return webhookValidation.error;
      }
    }

    // Validate user account and get plan
    const { user, plan, error: userError } = await validateUserAndPlan(userSub);
    if (userError) {
      return userError;
    }

    if (!user || !user.user_id) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'ACCOUNT_NOT_FOUND',
            message: 'User account not found',
          },
        }),
      };
    }

    const userId = user.user_id;

    // Check rate limit
    const rateLimitCheck = await checkRateLimit(userSub, userId, plan);
    if (!rateLimitCheck.allowed) {
      return rateLimitCheck.error;
    }

    // Check quota
    const quotaCheck = await checkQuota(userSub, user, plan);
    if (!quotaCheck.allowed) {
      return quotaCheck.error;
    }

    // Pre-validate page limit by generating PDF and checking page count
    // This ensures we return the error immediately instead of queuing and failing later
    let pdfResult;
    try {
      pdfResult = await generatePDF(content, inputType, options || {});
    } catch (error) {
      // Check for page limit exceeded error
      if (error.message && error.message.startsWith('PAGE_LIMIT_EXCEEDED:')) {
        const [, pageCount, maxPages] = error.message.split(':');
        logger.warn('Page limit exceeded in longjob handler', {
          userSub,
          pageCount: parseInt(pageCount, 10),
          maxPages: parseInt(maxPages, 10),
        });
        return BadRequest.PAGE_LIMIT_EXCEEDED(parseInt(pageCount, 10), parseInt(maxPages, 10));
      }
      // For other PDF generation errors, log and return generic error
      logger.error('PDF generation failed in longjob handler', {
        error: error.message,
        userSub,
      });
      return InternalServerError.PDF_GENERATION_FAILED(error.message);
    }

    // Page limit check passed, continue with queuing
    const { pages } = pdfResult;
    logger.info('Page limit check passed, queuing job', {
      userSub,
      pages,
    });

    // Get user's default webhook URL if not provided in request
    const finalWebhookUrl = webhookUrl || user.webhook_url || null;

    // Generate job ID
    const jobId = generateJobId();

    // Create job record with status 'queued'
    await createJobRecord({
      jobId,
      userId,
      jobType: 'long',
      mode: inputType,
      status: 'queued',
      webhookUrl: finalWebhookUrl,
    });

    // Prepare SQS message
    const messageBody = {
      job_id: jobId,
      user_id: userId,
      user_sub: userSub, // Keep for backward compatibility in processor
      input_type: inputType,
      content,
      options: options || {},
      webhook_url: finalWebhookUrl,
    };

    // Send message to SQS queue
    try {
      const command = new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(messageBody),
      });

      await sqsClient.send(command);

      logger.info('Job queued successfully', {
        jobId,
        userSub,
        queueUrl: QUEUE_URL,
      });
    } catch (sqsError) {
      logger.error('Error sending message to SQS', {
        error: sqsError.message,
        jobId,
      });

      // Update job status to failed
      const { updateJobRecord } = require('../services/jobTracking');
      await updateJobRecord(jobId, {
        status: 'failed',
        error_message: `Failed to queue job: ${sqsError.message}`,
      });

      return InternalServerError.GENERIC('Failed to queue job for processing');
    }

    // Calculate estimated completion time (rough estimate: 2-5 minutes)
    const estimatedCompletion = new Date();
    estimatedCompletion.setMinutes(estimatedCompletion.getMinutes() + 3);

    // Return 202 Accepted with job ID
    return {
      statusCode: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: jobId,
        status: 'queued',
        message: 'Job queued for processing',
        estimated_completion: estimatedCompletion.toISOString(),
      }),
    };
  } catch (error) {
    logger.error('LongJob handler error', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

module.exports = { handler };

