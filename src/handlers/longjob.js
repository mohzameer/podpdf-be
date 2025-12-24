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

    // Check rate limit
    const rateLimitCheck = await checkRateLimit(userSub, plan);
    if (!rateLimitCheck.allowed) {
      return rateLimitCheck.error;
    }

    // Check quota
    const quotaCheck = await checkQuota(userSub, user, plan);
    if (!quotaCheck.allowed) {
      return quotaCheck.error;
    }

    // Get user's default webhook URL if not provided in request
    const finalWebhookUrl = webhookUrl || user.webhook_url || null;

    // Generate job ID
    const jobId = generateJobId();

    // Create job record with status 'queued'
    await createJobRecord({
      jobId,
      userSub,
      jobType: 'long',
      mode: inputType,
      status: 'queued',
      webhookUrl: finalWebhookUrl,
    });

    // Prepare SQS message
    const messageBody = {
      job_id: jobId,
      user_sub: userSub,
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

