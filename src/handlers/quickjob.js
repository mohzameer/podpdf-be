/**
 * QuickJob handler
 * Handles: POST /quickjob
 * Synchronous PDF generation for small documents (<30 seconds)
 */

const logger = require('../utils/logger');
const { extractUserInfo } = require('../middleware/apiKeyAuth');
const { validateRequestBody } = require('../services/validation');
const {
  validateUserAndPlan,
  checkRateLimit,
  checkQuota,
  incrementPdfCount,
} = require('../services/business');
const {
  generateJobId,
  createJobRecord,
  updateJobRecord,
  createAnalyticsRecord,
} = require('../services/jobTracking');
const { generatePDF } = require('../services/pdf');
const { BadRequest, Forbidden, InternalServerError, RequestTimeout } = require('../utils/errors');

const QUICKJOB_TIMEOUT_SECONDS = parseInt(process.env.QUICKJOB_TIMEOUT_SECONDS || '30', 10);

/**
 * POST /quickjob - Generate PDF synchronously
 */
async function handler(event) {
  const startTime = Date.now();
  let jobId = null;
  let userSub = null;

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

    const { inputType, content, options } = validation.data;

    // Get user account and plan
    let user, plan, userId;
    
    if (userInfo.authMethod === 'api_key') {
      // API key path: we already have userId, just need to get user account and plan
      userId = userInfo.userId;
      const { getUserAccount } = require('../services/business');
      user = await getUserAccount(userInfo.userSub);
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
      const validationResult = await validateUserAndPlan(userInfo.userSub);
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
    
    userSub = userInfo.userSub || user.user_sub;

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

    // Generate job ID
    jobId = generateJobId();

    // Create job record with status 'processing'
    await createJobRecord({
      jobId,
      userId,
      jobType: 'quick',
      mode: inputType,
      status: 'processing',
    });

    // Set up timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('QUICKJOB_TIMEOUT'));
      }, QUICKJOB_TIMEOUT_SECONDS * 1000);
    });

    // Generate PDF with timeout
    let pdfResult;
    try {
      pdfResult = await Promise.race([
        generatePDF(content, inputType, options),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error.message === 'QUICKJOB_TIMEOUT') {
        // Timeout occurred
        await updateJobRecord(jobId, {
          status: 'timeout',
          timeout_occurred: true,
          error_message: 'Job processing exceeded 30-second timeout',
        });

        await createAnalyticsRecord({
          jobId,
          jobType: 'quick',
          mode: inputType,
          status: 'timeout',
          jobDuration: Date.now() - startTime,
          timeoutOccurred: true,
        });

        return RequestTimeout.QUICKJOB_TIMEOUT(jobId, QUICKJOB_TIMEOUT_SECONDS);
      }
      
      // Check for page limit exceeded error
      if (error.message && error.message.startsWith('PAGE_LIMIT_EXCEEDED:')) {
        const [, pageCount, maxPages] = error.message.split(':');
        await updateJobRecord(jobId, {
          status: 'failed',
          error_message: `PDF page count (${pageCount}) exceeds maximum allowed pages (${maxPages})`,
        });

        await createAnalyticsRecord({
          jobId,
          jobType: 'quick',
          mode: inputType,
          status: 'failed',
          jobDuration: Date.now() - startTime,
        });

        const { BadRequest } = require('../utils/errors');
        return BadRequest.PAGE_LIMIT_EXCEEDED(parseInt(pageCount, 10), parseInt(maxPages, 10));
      }
      
      throw error;
    }

    const { pdf, pages } = pdfResult;

    // Update job record with completion
    await updateJobRecord(jobId, {
      status: 'completed',
      pages,
      truncated: false,
    });

    // Increment PDF count and track billing
    await incrementPdfCount(userSub, user.user_id, plan);

    // Create analytics record
    await createAnalyticsRecord({
      jobId,
      jobType: 'quick',
      mode: inputType,
      pages,
      status: 'success',
      jobDuration: Date.now() - startTime,
    });

    // Return PDF binary response
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="document.pdf"',
        'X-PDF-Pages': pages.toString(),
        'X-Job-Id': jobId,
      },
      body: pdf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    logger.error('QuickJob handler error', {
      error: error.message,
      stack: error.stack,
      jobId,
      userSub,
    });

    // Update job record with error if jobId exists
    if (jobId) {
      try {
        await updateJobRecord(jobId, {
          status: 'failed',
          error_message: error.message,
        });

        await createAnalyticsRecord({
          jobId,
          jobType: 'quick',
          status: 'failure',
          jobDuration: Date.now() - startTime,
        });
      } catch (updateError) {
        logger.error('Error updating job record on failure', {
          error: updateError.message,
        });
      }
    }

    return InternalServerError.PDF_GENERATION_FAILED(error.message);
  }
}

module.exports = { handler };

