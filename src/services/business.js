/**
 * Business Logic Service
 * Handles rate limiting, quota checking, and plan management
 */

const { getItem, updateItem, putItem } = require('./dynamodb');
const { Forbidden } = require('../utils/errors');
const logger = require('../utils/logger');

const USERS_TABLE = process.env.USERS_TABLE;
const USER_RATE_LIMITS_TABLE = process.env.USER_RATE_LIMITS_TABLE;
const PLANS_TABLE = process.env.PLANS_TABLE;
const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '20', 10);
const FREE_TIER_QUOTA = parseInt(process.env.FREE_TIER_QUOTA || '100', 10);

/**
 * Get user account from DynamoDB
 * @param {string} userSub - Cognito user sub
 * @returns {Promise<object|null>} User record or null
 */
async function getUserAccount(userSub) {
  try {
    // Query Users table by user_sub using GSI
    const { queryItems } = require('./dynamodb');
    const users = await queryItems(
      USERS_TABLE,
      'user_sub = :user_sub',
      { ':user_sub': userSub },
      'UserSubIndex'
    );

    if (users && users.length > 0) {
      return users[0];
    }

    return null;
  } catch (error) {
    logger.error('Error getting user account', {
      error: error.message,
      userSub,
    });
    throw error;
  }
}

/**
 * Get plan configuration from DynamoDB
 * @param {string} planId - Plan ID
 * @returns {Promise<object|null>} Plan record or null
 */
async function getPlan(planId) {
  try {
    const plan = await getItem(PLANS_TABLE, { plan_id: planId });
    return plan;
  } catch (error) {
    logger.error('Error getting plan', {
      error: error.message,
      planId,
    });
    return null;
  }
}

/**
 * Check and enforce rate limit for free tier users
 * @param {string} userSub - Cognito user sub
 * @param {object} plan - User's plan configuration
 * @returns {Promise<{allowed: boolean, error: object|null}>}
 */
async function checkRateLimit(userSub, plan) {
  try {
    // If plan has no rate limit (paid tier), allow
    if (!plan.rate_limit_per_minute) {
      return { allowed: true, error: null };
    }

    // Get current minute timestamp
    const now = new Date();
    const minuteTimestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;

    // Calculate TTL (1 hour from now)
    const ttl = Math.floor(now.getTime() / 1000) + 3600;

    // Try to get existing rate limit record
    let rateLimitRecord = await getItem(USER_RATE_LIMITS_TABLE, {
      user_sub: userSub,
      minute_timestamp: minuteTimestamp,
    });

    if (rateLimitRecord) {
      // Check if limit exceeded
      if (rateLimitRecord.request_count >= plan.rate_limit_per_minute) {
        const retryAfter = 60 - now.getSeconds(); // Seconds until next minute
        return {
          allowed: false,
          error: Forbidden.RATE_LIMIT_EXCEEDED(
            plan.rate_limit_per_minute,
            '1 minute',
            retryAfter
          ),
        };
      }

      // Increment counter atomically
      await updateItem(
        USER_RATE_LIMITS_TABLE,
        {
          user_sub: userSub,
          minute_timestamp: minuteTimestamp,
        },
        'SET request_count = request_count + :inc',
        { ':inc': 1 }
      );
    } else {
      // Create new rate limit record
      await putItem(USER_RATE_LIMITS_TABLE, {
        user_sub: userSub,
        minute_timestamp: minuteTimestamp,
        request_count: 1,
        ttl,
      });
    }

    return { allowed: true, error: null };
  } catch (error) {
    logger.error('Rate limit check error', {
      error: error.message,
      userSub,
    });
    // On error, allow the request (fail open)
    return { allowed: true, error: null };
  }
}

/**
 * Check and enforce quota for free tier users
 * @param {string} userSub - Cognito user sub
 * @param {object} user - User record
 * @param {object} plan - User's plan configuration
 * @returns {Promise<{allowed: boolean, error: object|null}>}
 */
async function checkQuota(userSub, user, plan) {
  try {
    // If plan has no monthly quota (paid tier), allow
    if (plan.monthly_quota === null || plan.monthly_quota === undefined) {
      return { allowed: true, error: null };
    }

    // Check all-time quota for free tier
    const currentUsage = user.total_pdf_count || 0;
    if (currentUsage >= FREE_TIER_QUOTA) {
      return {
        allowed: false,
        error: Forbidden.QUOTA_EXCEEDED(currentUsage, FREE_TIER_QUOTA),
      };
    }

    return { allowed: true, error: null };
  } catch (error) {
    logger.error('Quota check error', {
      error: error.message,
      userSub,
    });
    // On error, allow the request (fail open)
    return { allowed: true, error: null };
  }
}

/**
 * Increment PDF count for user
 * @param {string} userSub - Cognito user sub
 * @param {string} userId - User ID (ULID)
 * @returns {Promise<void>}
 */
async function incrementPdfCount(userSub, userId) {
  try {
    // Try to update by user_id first (primary key)
    try {
      await updateItem(
        USERS_TABLE,
        { user_id: userId },
        'SET total_pdf_count = if_not_exists(total_pdf_count, :zero) + :inc',
        { ':zero': 0, ':inc': 1 }
      );
    } catch (error) {
      // If user_id update fails, try to find by user_sub and update
      const user = await getUserAccount(userSub);
      if (user && user.user_id) {
        await updateItem(
          USERS_TABLE,
          { user_id: user.user_id },
          'SET total_pdf_count = if_not_exists(total_pdf_count, :zero) + :inc',
          { ':zero': 0, ':inc': 1 }
        );
      } else {
        logger.warn('Could not increment PDF count - user not found', {
          userSub,
          userId,
        });
      }
    }
  } catch (error) {
    logger.error('Error incrementing PDF count', {
      error: error.message,
      userSub,
      userId,
    });
    // Don't throw - PDF count increment is not critical
  }
}

/**
 * Validate user account and enforce business rules
 * @param {string} userSub - Cognito user sub
 * @returns {Promise<{user: object, plan: object, error: object|null}>}
 */
async function validateUserAndPlan(userSub) {
  try {
    // Get user account
    const user = await getUserAccount(userSub);
    if (!user) {
      return {
        user: null,
        plan: null,
        error: Forbidden.ACCOUNT_NOT_FOUND(),
      };
    }

    // Get plan configuration
    const planId = user.plan_id || 'free-basic';
    const plan = await getPlan(planId);

    if (!plan) {
      logger.warn('Plan not found, using default', { planId, userSub });
      // Use default free plan if plan not found
      const defaultPlan = {
        plan_id: 'free-basic',
        name: 'Free Basic',
        type: 'free',
        monthly_quota: FREE_TIER_QUOTA,
        price_per_pdf: 0,
        rate_limit_per_minute: RATE_LIMIT_PER_MINUTE,
        is_active: true,
      };
      return {
        user,
        plan: defaultPlan,
        error: null,
      };
    }

    return {
      user,
      plan,
      error: null,
    };
  } catch (error) {
    logger.error('Error validating user and plan', {
      error: error.message,
      userSub,
    });
    throw error;
  }
}

module.exports = {
  getUserAccount,
  getPlan,
  checkRateLimit,
  checkQuota,
  incrementPdfCount,
  validateUserAndPlan,
};

