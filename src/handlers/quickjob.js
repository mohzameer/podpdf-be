/**
 * QuickJob handler
 * Handles: POST /quickjob
 * Synchronous PDF generation for small documents (<30 seconds)
 */

const logger = require('../utils/logger');
const { extractUserSub } = require('../middleware/auth');
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
    // Extract user sub from JWT
    userSub = await extractUserSub(event);
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

    const { inputType, content, options } = validation.data;

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

