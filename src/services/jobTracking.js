/**
 * Job Tracking Service
 * Handles job record creation, updates, and analytics logging
 */

const { v4: uuidv4 } = require('uuid');
const { putItem, updateItem, getItem, queryItems } = require('./dynamodb');
const logger = require('../utils/logger');

const JOB_DETAILS_TABLE = process.env.JOB_DETAILS_TABLE;
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE;

/**
 * Generate a unique job ID (UUID)
 * @returns {string} Job ID
 */
function generateJobId() {
  return uuidv4();
}

/**
 * Create a job record in JobDetails table
 * @param {object} jobData - Job data
 * @returns {Promise<object>} Created job record
 */
async function createJobRecord(jobData) {
  try {
    const {
      jobId,
      userId, // user_id (ULID) instead of userSub
      jobType, // 'quick' or 'long'
      mode, // 'html' or 'markdown'
      status, // 'queued', 'processing', 'completed', 'failed', 'timeout'
      webhookUrl, // Optional, for long jobs
      apiKeyId, // Optional, ULID of the API key used for this job (null if JWT was used)
    } = jobData;

    const now = new Date().toISOString();

    const jobRecord = {
      job_id: jobId,
      user_id: userId,
      job_type: jobType,
      mode,
      status,
      created_at: now,
      ...(webhookUrl && { webhook_url: webhookUrl }),
      ...(apiKeyId && { api_key_id: apiKeyId }),
    };

    await putItem(JOB_DETAILS_TABLE, jobRecord);

    logger.info('Job record created', {
      jobId,
      jobType,
      status,
      userId,
      apiKeyId: apiKeyId || null,
    });

    return jobRecord;
  } catch (error) {
    logger.error('Error creating job record', {
      error: error.message,
      jobData,
    });
    throw error;
  }
}

/**
 * Update job record
 * @param {string} jobId - Job ID
 * @param {object} updates - Fields to update
 * @returns {Promise<object>} Updated job record
 */
async function updateJobRecord(jobId, updates) {
  try {
    const updateExpressionParts = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};

    let updateExpr = 'SET ';
    const setParts = [];

    Object.keys(updates).forEach((key, index) => {
      const valueKey = `:val${index}`;
      const nameKey = `key${index}`;
      
      setParts.push(`#${nameKey} = ${valueKey}`);
      expressionAttributeNames[`#${nameKey}`] = key;
      expressionAttributeValues[valueKey] = updates[key];
    });

    updateExpr += setParts.join(', ');

    // Add completed_at if status is being set to completed
    if (updates.status === 'completed' && !updates.completed_at) {
      updateExpr += ', completed_at = :completed_at';
      expressionAttributeValues[':completed_at'] = new Date().toISOString();
    }

    const updated = await updateItem(
      JOB_DETAILS_TABLE,
      { job_id: jobId },
      updateExpr,
      expressionAttributeValues,
      expressionAttributeNames
    );

    logger.debug('Job record updated', {
      jobId,
      updates,
    });

    return updated;
  } catch (error) {
    logger.error('Error updating job record', {
      error: error.message,
      jobId,
      updates,
    });
    throw error;
  }
}

/**
 * Atomically update job status from 'queued' to 'processing'
 * Used for deduplication in longjob-processor
 * @param {string} jobId - Job ID
 * @returns {Promise<{success: boolean, job: object|null}>}
 */
async function atomicallyStartProcessing(jobId) {
  try {
    // First, get the current job record
    const job = await getItem(JOB_DETAILS_TABLE, { job_id: jobId });

    if (!job) {
      return { success: false, job: null };
    }

    // If already processing or completed, skip
    if (job.status === 'processing' || job.status === 'completed') {
      return { success: false, job };
    }

    // Try to update status from 'queued' to 'processing' atomically
    try {
      const updated = await updateItem(
        JOB_DETAILS_TABLE,
        { job_id: jobId },
        'SET #status = :processing',
        { ':processing': 'processing' },
        { '#status': 'status' }
      );

      return { success: true, job: updated };
    } catch (error) {
      // Conditional update failed - another instance is processing
      logger.debug('Job already being processed by another instance', {
        jobId,
      });
      return { success: false, job };
    }
  } catch (error) {
    logger.error('Error atomically starting processing', {
      error: error.message,
      jobId,
    });
    return { success: false, job: null };
  }
}

/**
 * Get job record
 * @param {string} jobId - Job ID
 * @returns {Promise<object|null>} Job record or null
 */
async function getJobRecord(jobId) {
  try {
    const job = await getItem(JOB_DETAILS_TABLE, { job_id: jobId });
    return job;
  } catch (error) {
    logger.error('Error getting job record', {
      error: error.message,
      jobId,
    });
    return null;
  }
}

/**
 * List jobs for a user
 * @param {string} userId - User ID (ULID)
 * @param {object} options - Query options
 * @param {number} options.limit - Maximum number of jobs to return (default: 50, max: 100)
 * @param {string} options.nextToken - Pagination token
 * @param {string} options.status - Filter by status (optional)
 * @param {string} options.jobType - Filter by job_type (optional)
 * @param {boolean} options.truncated - Filter by truncated flag (optional)
 * @returns {Promise<{jobs: array, nextToken: string|null, count: number}>}
 */
async function listJobsByUserId(userId, options = {}) {
  try {
    const limit = Math.min(Math.max(parseInt(options.limit) || 50, 1), 100);
    const nextToken = options.nextToken || null;

    // Build filter expression for additional filters
    let filterExpression = null;
    const expressionAttributeValues = { ':user_id': userId };
    const expressionAttributeNames = {};

    if (options.status) {
      filterExpression = filterExpression 
        ? `${filterExpression} AND #status = :status`
        : '#status = :status';
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = options.status;
    }

    if (options.jobType) {
      filterExpression = filterExpression
        ? `${filterExpression} AND #job_type = :job_type`
        : '#job_type = :job_type';
      expressionAttributeNames['#job_type'] = 'job_type';
      expressionAttributeValues[':job_type'] = options.jobType;
    }

    if (options.truncated !== undefined && options.truncated !== null) {
      filterExpression = filterExpression
        ? `${filterExpression} AND truncated = :truncated`
        : 'truncated = :truncated';
      expressionAttributeValues[':truncated'] = options.truncated;
    }

    // Parse nextToken if provided
    let exclusiveStartKey = null;
    if (nextToken) {
      try {
        exclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString());
      } catch (error) {
        logger.warn('Invalid nextToken provided', { nextToken, error: error.message });
      }
    }

    // Query jobs by user_id using GSI, ordered by created_at descending
    const { query } = require('./dynamodb');
    const result = await query(
      JOB_DETAILS_TABLE,
      'user_id = :user_id',
      expressionAttributeValues,
      'UserIdCreatedAtIndex',
      limit,
      exclusiveStartKey,
      filterExpression,
      Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : null,
      false // scanIndexForward = false (descending order)
    );

    const jobs = (result.Items || []).map(job => {
      // Build response object (exclude internal fields)
      const jobResponse = {
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
        jobResponse.s3_url = job.s3_url || null;
        jobResponse.s3_url_expires_at = job.s3_url_expires_at || null;
        jobResponse.webhook_delivered = job.webhook_delivered || false;
        jobResponse.webhook_delivered_at = job.webhook_delivered_at || null;
        jobResponse.webhook_retry_count = job.webhook_retry_count || 0;
      }

      // Add quick job specific fields
      if (job.job_type === 'quick') {
        jobResponse.timeout_occurred = job.timeout_occurred || false;
      }

      return jobResponse;
    });

    return {
      jobs,
      nextToken: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64') : null,
      count: jobs.length,
    };
  } catch (error) {
    logger.error('Error listing jobs', {
      error: error.message,
      userId,
      options,
    });
    throw error;
  }
}

/**
 * Create analytics record
 * @param {object} analyticsData - Analytics data
 * @returns {Promise<void>}
 */
async function createAnalyticsRecord(analyticsData) {
  try {
    const {
      jobId,
      jobType,
      mode,
      pages,
      status,
      jobDuration,
      country,
      timeoutOccurred,
      webhookRetryCount,
    } = analyticsData;

    const analyticsRecord = {
      job_id: jobId,
      job_type: jobType,
      mode,
      pages: pages || 0,
      status,
      job_duration: jobDuration || 0,
      created_at: new Date().toISOString(),
      ...(country && { country }),
      ...(timeoutOccurred !== undefined && { timeout_occurred: timeoutOccurred }),
      ...(webhookRetryCount !== undefined && { webhook_retry_count: webhookRetryCount }),
    };

    await putItem(ANALYTICS_TABLE, analyticsRecord);

    logger.debug('Analytics record created', {
      jobId,
      jobType,
      status,
    });
  } catch (error) {
    logger.error('Error creating analytics record', {
      error: error.message,
      analyticsData,
    });
    // Don't throw - analytics logging is not critical
  }
}

module.exports = {
  generateJobId,
  createJobRecord,
  updateJobRecord,
  atomicallyStartProcessing,
  getJobRecord,
  listJobsByUserId,
  createAnalyticsRecord,
};

