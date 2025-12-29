/**
 * LongJob handler
 * Handles: POST /longjob
 * Asynchronous PDF generation with queueing, S3 storage, and webhook notifications
 * Note: Image uploads are not supported in longjob - use /quickjob for images
 */

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const logger = require('../utils/logger');
const { extractUserInfo } = require('../middleware/apiKeyAuth');
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
    // Extract user info from either JWT token or API key
    const userInfo = await extractUserInfo(event);
    if (!userInfo.userId && !userInfo.userSub) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid authentication. Provide either JWT token or API key.',
          },
        }),
      };
    }

    // Check if this is a multipart/form-data request (image upload)
    // Images are not supported in longjob - they complete fast enough for quickjob
    const headers = event.headers || {};
    const contentType = headers['content-type'] || headers['Content-Type'] || '';
    if (contentType.includes('multipart/form-data')) {
      logger.info('Rejecting multipart request in longjob - images not supported', {
        contentType,
      });
      return BadRequest.INVALID_PARAMETER(
        'content-type',
        'Image uploads (multipart/form-data) are not supported in /longjob. Use /quickjob for image-to-PDF conversion - images are fast enough to complete within the 30-second timeout.'
      );
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

    // Get user account and plan
    let user, plan, userId, userSub;
    
    if (userInfo.authMethod === 'api_key') {
      // API key path: we already have userId, just need to get user account and plan
      userId = userInfo.userId;
      userSub = userInfo.userSub;
      user = await getUserAccount(userSub);
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
      
      // Get plan
      const { getPlan } = require('../services/business');
      const planId = user.plan_id || 'free-basic';
      plan = await getPlan(planId);
      if (!plan) {
        plan = {
          plan_id: 'free-basic',
          name: 'Free Basic',
          type: 'free',
          monthly_quota: parseInt(process.env.FREE_TIER_QUOTA) || 100,
          price_per_pdf: 0,
          rate_limit_per_minute: parseInt(process.env.RATE_LIMIT_PER_MINUTE) || 20,
          is_active: true,
        };
      }
    } else {
      // JWT path: use existing validateUserAndPlan
      userSub = userInfo.userSub;
      const validationResult = await validateUserAndPlan(userSub);
      if (validationResult.error) {
        return validationResult.error;
      }
      user = validationResult.user;
      plan = validationResult.plan;
      
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
      
      userId = user.user_id;
    }

    // Check rate limit
    const rateLimitCheck = await checkRateLimit(userId, plan);
    if (!rateLimitCheck.allowed) {
      return rateLimitCheck.error;
    }

    // Check quota (checkQuota needs userSub for billing lookup)
    const quotaCheck = await checkQuota(userSub || user.user_sub, user, plan);
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
      apiKeyId: userInfo.apiKeyId || null, // Track which API key was used (null if JWT)
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

