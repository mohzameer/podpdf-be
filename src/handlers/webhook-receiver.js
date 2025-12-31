/**
 * Webhook Receiver handler
 * Handles: POST /webhook/job-done
 * Receives webhook notifications from api.podpdf.com when jobs complete
 * Validates payload structure before processing to prevent abuse
 */

const logger = require('../utils/logger');
const { BadRequest, InternalServerError } = require('../utils/errors');
const { getJobRecord } = require('../services/jobTracking');

/**
 * Validate webhook payload structure
 * @param {object} body - Webhook payload
 * @returns {object} Validation result with isValid, error, and parsed data
 */
function validateWebhookPayload(body) {
  // Check if body exists and is an object
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      isValid: false,
      error: BadRequest.INVALID_PARAMETER('body', 'Request body must be a valid JSON object'),
    };
  }

  // Validate required fields
  const requiredFields = ['job_id', 'status'];
  const missingFields = requiredFields.filter(field => !body[field]);

  if (missingFields.length > 0) {
    return {
      isValid: false,
      error: BadRequest.INVALID_PARAMETER(
        'body',
        `Missing required fields: ${missingFields.join(', ')}`
      ),
    };
  }

  // Validate job_id format (should be UUID)
  const jobId = body.job_id;
  if (typeof jobId !== 'string' || jobId.trim().length === 0) {
    return {
      isValid: false,
      error: BadRequest.INVALID_PARAMETER('job_id', 'job_id must be a non-empty string'),
    };
  }

  // Basic UUID format validation (8-4-4-4-12 hex characters)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(jobId)) {
    return {
      isValid: false,
      error: BadRequest.INVALID_PARAMETER('job_id', 'job_id must be a valid UUID format'),
    };
  }

  // Validate status field
  const status = body.status;
  const validStatuses = ['queued', 'processing', 'completed', 'failed', 'timeout'];
  if (typeof status !== 'string' || !validStatuses.includes(status)) {
    return {
      isValid: false,
      error: BadRequest.INVALID_PARAMETER(
        'status',
        `status must be one of: ${validStatuses.join(', ')}`
      ),
    };
  }

  // Validate optional fields if present
  if (body.pages !== undefined) {
    if (typeof body.pages !== 'number' || body.pages < 0 || !Number.isInteger(body.pages)) {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER('pages', 'pages must be a non-negative integer'),
      };
    }
  }

  if (body.mode !== undefined) {
    const validModes = ['html', 'markdown', 'image'];
    if (typeof body.mode !== 'string' || !validModes.includes(body.mode)) {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER('mode', `mode must be one of: ${validModes.join(', ')}`),
      };
    }
  }

  if (body.truncated !== undefined && typeof body.truncated !== 'boolean') {
    return {
      isValid: false,
      error: BadRequest.INVALID_PARAMETER('truncated', 'truncated must be a boolean'),
    };
  }

  if (body.s3_url !== undefined) {
    if (typeof body.s3_url !== 'string' || body.s3_url.trim().length === 0) {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER('s3_url', 's3_url must be a non-empty string'),
      };
    }
    // Basic URL validation
    try {
      new URL(body.s3_url);
    } catch (error) {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER('s3_url', 's3_url must be a valid URL'),
      };
    }
  }

  if (body.s3_url_expires_at !== undefined) {
    if (typeof body.s3_url_expires_at !== 'string') {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER(
          's3_url_expires_at',
          's3_url_expires_at must be a string (ISO 8601 format)'
        ),
      };
    }
    // Validate ISO 8601 format
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
    if (!isoDateRegex.test(body.s3_url_expires_at)) {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER(
          's3_url_expires_at',
          's3_url_expires_at must be in ISO 8601 format'
        ),
      };
    }
  }

  if (body.created_at !== undefined) {
    if (typeof body.created_at !== 'string') {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER(
          'created_at',
          'created_at must be a string (ISO 8601 format)'
        ),
      };
    }
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
    if (!isoDateRegex.test(body.created_at)) {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER('created_at', 'created_at must be in ISO 8601 format'),
      };
    }
  }

  if (body.completed_at !== undefined) {
    if (typeof body.completed_at !== 'string') {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER(
          'completed_at',
          'completed_at must be a string (ISO 8601 format)'
        ),
      };
    }
    const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
    if (!isoDateRegex.test(body.completed_at)) {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER(
          'completed_at',
          'completed_at must be in ISO 8601 format'
        ),
      };
    }
  }

  if (body.error_message !== undefined && body.error_message !== null) {
    if (typeof body.error_message !== 'string') {
      return {
        isValid: false,
        error: BadRequest.INVALID_PARAMETER('error_message', 'error_message must be a string or null'),
      };
    }
  }

  // Validate payload size (prevent abuse with huge payloads)
  const payloadSize = Buffer.byteLength(JSON.stringify(body), 'utf8');
  const MAX_PAYLOAD_SIZE = 100 * 1024; // 100KB max payload
  if (payloadSize > MAX_PAYLOAD_SIZE) {
    return {
      isValid: false,
      error: BadRequest.INVALID_PARAMETER(
        'body',
        `Payload size (${Math.round(payloadSize / 1024)}KB) exceeds maximum allowed size (${MAX_PAYLOAD_SIZE / 1024}KB)`
      ),
    };
  }

  return {
    isValid: true,
    error: null,
    data: {
      jobId: jobId.trim(),
      status: status,
      pages: body.pages,
      mode: body.mode,
      truncated: body.truncated || false,
      s3Url: body.s3_url,
      s3UrlExpiresAt: body.s3_url_expires_at,
      createdAt: body.created_at,
      completedAt: body.completed_at,
      errorMessage: body.error_message,
    },
  };
}

/**
 * POST /webhook/job-done - Receive webhook notification
 */
async function handler(event) {
  try {
    // Log request for monitoring
    const sourceIp = event.requestContext?.http?.sourceIp || 
                     event.requestContext?.identity?.sourceIp ||
                     'unknown';
    
    logger.info('Webhook receiver request received', {
      sourceIp,
      path: event.requestContext?.http?.path || event.path,
    });

    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      logger.warn('Invalid JSON in webhook request', {
        error: error.message,
        sourceIp,
      });
      return BadRequest.INVALID_PARAMETER('body', 'Request body must be valid JSON');
    }

    // Validate webhook payload structure
    const validation = validateWebhookPayload(body);
    if (!validation.isValid) {
      logger.warn('Webhook payload validation failed', {
        sourceIp,
        jobId: body.job_id,
        error: validation.error.body,
      });
      return validation.error;
    }

    const { jobId, status } = validation.data;

    // Verify job exists in our system
    const job = await getJobRecord(jobId);
    if (!job) {
      logger.warn('Webhook received for non-existent job', {
        sourceIp,
        jobId,
      });
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'JOB_NOT_FOUND',
            message: 'Job not found',
          },
        }),
      };
    }

    // Verify job status matches (prevent replay attacks with old statuses)
    if (job.status !== status) {
      logger.warn('Webhook status mismatch', {
        sourceIp,
        jobId,
        webhookStatus: status,
        actualStatus: job.status,
      });
      return BadRequest.INVALID_PARAMETER(
        'status',
        `Status mismatch: webhook reports '${status}' but job status is '${job.status}'`
      );
    }

    // Log successful webhook receipt
    logger.info('Webhook received and validated', {
      jobId,
      status,
      sourceIp,
      userId: job.user_id,
    });

    // TODO: Add your custom processing logic here
    // - Extract user_id from job
    // - Map to your internal user system
    // - Trigger your internal workflows
    // - Update your internal database
    // - Send notifications, etc.

    // Return success response
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Webhook received successfully',
        job_id: jobId,
        status: status,
      }),
    };
  } catch (error) {
    logger.error('Webhook receiver error', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

module.exports = { handler };

