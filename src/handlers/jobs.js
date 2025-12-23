/**
 * Jobs handler
 * Handles: GET /jobs/{job_id}
 */

const logger = require('../utils/logger');
const { extractUserSub } = require('../middleware/auth');
const { getJobRecord } = require('../services/jobTracking');
const { Forbidden, InternalServerError } = require('../utils/errors');

/**
 * GET /jobs/{job_id} - Get job status and details
 */
async function handler(event) {
  try {
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

    // Extract job_id from path
    const path = event.requestContext?.http?.path || event.path;
    const pathParams = event.requestContext?.http?.pathParameters || event.pathParameters || {};
    const jobId = pathParams.job_id;

    if (!jobId) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'MISSING_JOB_ID',
            message: 'job_id is required in the path',
          },
        }),
      };
    }

    logger.info('Getting job details', { jobId, userSub });

    // Get job record
    const job = await getJobRecord(jobId);

    if (!job) {
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

    // Verify job belongs to user
    if (job.user_sub !== userSub) {
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

    // Build response (exclude internal fields)
    const response = {
      job_id: job.job_id,
      status: job.status,
      job_type: job.job_type,
      mode: job.mode,
      pages: job.pages || null,
      truncated: job.truncated || false,
      created_at: job.created_at,
      completed_at: job.completed_at || null,
      error_message: job.error_message || null,
    };

    // Add long job specific fields
    if (job.job_type === 'long') {
      response.s3_url = job.s3_url || null;
      response.s3_url_expires_at = job.s3_url_expires_at || null;
      response.webhook_delivered = job.webhook_delivered || false;
      response.webhook_delivered_at = job.webhook_delivered_at || null;
      response.webhook_retry_count = job.webhook_retry_count || 0;
    }

    // Add quick job specific fields
    if (job.job_type === 'quick') {
      response.timeout_occurred = job.timeout_occurred || false;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(response),
    };
  } catch (error) {
    logger.error('Jobs handler error', { error: error.message, stack: error.stack });
    return InternalServerError.GENERIC(error.message);
  }
}

module.exports = { handler };

