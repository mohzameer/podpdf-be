/**
 * Jobs handler
 * Handles: GET /jobs and GET /jobs/{job_id}
 */

const logger = require('../utils/logger');
const { wrapHandler } = require('../utils/sentry');
const { extractUserSub } = require('../middleware/auth');
const { getJobRecord, listJobsByUserId } = require('../services/jobTracking');
const { Forbidden, InternalServerError, BadRequest } = require('../utils/errors');

/**
 * GET /jobs - List jobs for authenticated user
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

    // Get user account to get user_id
    const { getUserAccount } = require('../services/business');
    const user = await getUserAccount(userSub);
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

    // Extract path and query parameters
    const path = event.requestContext?.http?.path || event.path;
    const pathParams = event.requestContext?.http?.pathParameters || event.pathParameters || {};
    const queryParams = event.requestContext?.http?.queryStringParameters || event.queryStringParameters || {};
    const jobId = pathParams.job_id;
    const method = event.requestContext?.http?.method || event.httpMethod;

    // If no job_id, handle list jobs endpoint
    if (!jobId) {
      return await handleListJobs(userId, queryParams);
    }

    // Check if this is a webhook history request
    if (path.endsWith('/webhooks/history') && method === 'GET') {
      return await handleGetJobWebhookHistory(jobId, userId, userSub, queryParams);
    }

    // Handle get single job endpoint
    logger.info('Getting job details', { jobId, userId, userSub });

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

    // Verify job belongs to user (check user_id, fallback to user_sub for migration)
    const jobUserId = job.user_id || job.user_sub;
    if (jobUserId !== userId && jobUserId !== userSub) {
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

/**
 * Handle GET /jobs - List jobs for authenticated user
 */
async function handleListJobs(userId, queryParams) {
  try {
    // Parse query parameters
    const limit = queryParams.limit ? parseInt(queryParams.limit, 10) : 50;
    if (isNaN(limit) || limit < 1 || limit > 100) {
      return BadRequest.INVALID_PARAMETER('limit', 'Must be a number between 1 and 100');
    }

    const nextToken = queryParams.next_token || null;
    const status = queryParams.status || null;
    const jobType = queryParams.job_type || null;
    const truncated = queryParams.truncated !== undefined ? queryParams.truncated === 'true' : null;

    // Validate status filter
    if (status && !['queued', 'processing', 'completed', 'failed', 'timeout'].includes(status)) {
      return BadRequest.INVALID_PARAMETER('status', 'Must be one of: queued, processing, completed, failed, timeout');
    }

    // Validate job_type filter
    if (jobType && !['quick', 'long'].includes(jobType)) {
      return BadRequest.INVALID_PARAMETER('job_type', 'Must be one of: quick, long');
    }

    // Validate truncated filter
    if (truncated !== null && typeof truncated !== 'boolean') {
      return BadRequest.INVALID_PARAMETER('truncated', 'Must be true or false');
    }

    // List jobs
    const result = await listJobsByUserId(userId, {
      limit,
      nextToken,
      status,
      jobType,
      truncated,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobs: result.jobs,
        next_token: result.nextToken,
        count: result.count,
      }),
    };
  } catch (error) {
    logger.error('List jobs handler error', { error: error.message, stack: error.stack, userId });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * Handle GET /jobs/{job_id}/webhooks/history - Get webhook history for a job
 */
async function handleGetJobWebhookHistory(jobId, userId, userSub, queryParams) {
  try {
    // Verify job exists and belongs to user
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
    const jobUserId = job.user_id || job.user_sub;
    if (jobUserId !== userId && jobUserId !== userSub) {
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

    // Get webhook history for this job
    const { getWebhookHistoryByJobId } = require('../services/webhookDelivery');
    
    const filters = {
      status: queryParams.status,
      event_type: queryParams.event_type,
      limit: queryParams.limit ? parseInt(queryParams.limit, 10) : undefined,
      next_token: queryParams.next_token,
    };

    const result = await getWebhookHistoryByJobId(jobId, filters);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: jobId,
        ...result,
      }),
    };
  } catch (error) {
    logger.error('Get job webhook history error', {
      error: error.message,
      stack: error.stack,
      jobId,
      userId,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

module.exports = { handler: wrapHandler(handler) };

