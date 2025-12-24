/**
 * Job Tracking Service
 * Handles job record creation, updates, and analytics logging
 */

const { v4: uuidv4 } = require('uuid');
const { putItem, updateItem, getItem } = require('./dynamodb');
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
      userSub,
      jobType, // 'quick' or 'long'
      mode, // 'html' or 'markdown'
      status, // 'queued', 'processing', 'completed', 'failed', 'timeout'
      webhookUrl, // Optional, for long jobs
    } = jobData;

    const now = new Date().toISOString();

    const jobRecord = {
      job_id: jobId,
      user_sub: userSub,
      job_type: jobType,
      mode,
      status,
      created_at: now,
      ...(webhookUrl && { webhook_url: webhookUrl }),
    };

    await putItem(JOB_DETAILS_TABLE, jobRecord);

    logger.info('Job record created', {
      jobId,
      jobType,
      status,
      userSub,
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

    Object.keys(updates).forEach((key, index) {
      const valueKey = `:val${index}`;
      const nameKey = `#key${index}`;
      
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
  createAnalyticsRecord,
};

