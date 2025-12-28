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
const BILLS_TABLE = process.env.BILLS_TABLE;
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
 * @param {string} userId - User ID (ULID)
 * @param {object} plan - User's plan configuration
 * @returns {Promise<{allowed: boolean, error: object|null}>}
 */
async function checkRateLimit(userId, plan) {
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

    // Use user_id for rate limiting (consistent across all tables)
    let rateLimitRecord = await getItem(USER_RATE_LIMITS_TABLE, {
      user_id: userId,
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
          user_id: userId,
          minute_timestamp: minuteTimestamp,
        },
        'SET request_count = request_count + :inc',
        { ':inc': 1 }
      );
    } else {
      // Create new rate limit record with user_id
      await putItem(USER_RATE_LIMITS_TABLE, {
        user_id: userId,
        minute_timestamp: minuteTimestamp,
        request_count: 1,
        ttl,
      });
    }

    return { allowed: true, error: null };
  } catch (error) {
    logger.error('Rate limit check error', {
      error: error.message,
      userId,
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
    // If plan type is paid or plan has no monthly quota (paid tier), allow
    if (plan.type === 'paid' || plan.monthly_quota === null || plan.monthly_quota === undefined) {
      // Only clear quota_exceeded flag if plan type is explicitly paid
      if (plan.type === 'paid' && user.quota_exceeded && user.user_id) {
        try {
          await updateItem(
            USERS_TABLE,
            { user_id: user.user_id },
            'SET quota_exceeded = :false',
            { ':false': false }
          );
        } catch (error) {
          logger.warn('Could not clear quota_exceeded flag', {
            userSub,
            userId: user.user_id,
            error: error.message,
          });
        }
      }
      // If it's a paid plan, allow
      if (plan.type === 'paid') {
        return { allowed: true, error: null };
      }
      // If monthly_quota is null/undefined but plan type is not paid, fall through to use FREE_TIER_QUOTA
    }

    // Check all-time quota for free tier using quota from plan
    const quotaLimit = plan.monthly_quota || FREE_TIER_QUOTA; // Fallback to env var if plan quota is missing
    const currentUsage = user.total_pdf_count || 0;
    if (currentUsage >= quotaLimit) {
      // Set quota_exceeded flag if not already set
      if (!user.quota_exceeded && user.user_id) {
        try {
          await updateItem(
            USERS_TABLE,
            { user_id: user.user_id },
            'SET quota_exceeded = :true',
            { ':true': true }
          );
        } catch (error) {
          logger.warn('Could not set quota_exceeded flag', {
            userSub,
            userId: user.user_id,
            error: error.message,
          });
        }
      }
      return {
        allowed: false,
        error: Forbidden.QUOTA_EXCEEDED(currentUsage, quotaLimit, true),
      };
    }

    // Clear quota_exceeded flag if user is under quota
    if (user.quota_exceeded && user.user_id) {
      try {
        await updateItem(
          USERS_TABLE,
          { user_id: user.user_id },
          'SET quota_exceeded = :false',
          { ':false': false }
        );
      } catch (error) {
        logger.warn('Could not clear quota_exceeded flag', {
          userSub,
          userId: user.user_id,
          error: error.message,
        });
      }
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
 * Increment PDF count for user and track billing for paid users in Bills table
 * @param {string} userSub - Cognito user sub
 * @param {string} userId - User ID (ULID)
 * @param {object} plan - User's plan configuration (optional, for billing tracking)
 * @returns {Promise<void>}
 */
async function incrementPdfCount(userSub, userId, plan = null) {
  try {
    // Get current month in YYYY-MM format
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const nowISO = now.toISOString();
    
    // Get user account
    const user = await getUserAccount(userSub);
    if (!user) {
      logger.warn('Could not increment PDF count - user not found', {
        userSub,
        userId,
      });
      return;
    }
    
    // Check if plan has free credits and consume them first
    let billingIncrement = 0;
    const isPaidPlan = plan && plan.type === 'paid' && plan.price_per_pdf;
    const hasFreeCredits = plan && plan.free_credits && plan.free_credits > 0;
    
    if (hasFreeCredits && isPaidPlan) {
      // Try to consume free credit first
      try {
        // Atomically decrement free_credits_remaining
        const updatedUser = await updateItem(
          USERS_TABLE,
          { user_id: userId },
          'SET free_credits_remaining = if_not_exists(free_credits_remaining, :zero) - :dec',
          { ':zero': 0, ':dec': 1 }
        );
        
        const remainingCredits = updatedUser.free_credits_remaining;
        
        // Charge only if free credits are exhausted (<= 0)
        if (remainingCredits <= 0) {
          billingIncrement = plan.price_per_pdf;
          logger.debug('Free credits exhausted, charging user', {
            userId,
            remainingCredits,
            charge: billingIncrement,
          });
        } else {
          logger.debug('Free credit used, no charge', {
            userId,
            remainingCredits,
          });
        }
      } catch (error) {
        // If update fails, charge to be safe
        logger.warn('Error consuming free credit, charging user', {
          userId,
          error: error.message,
        });
        billingIncrement = plan.price_per_pdf;
      }
    } else if (isPaidPlan) {
      // No free credits, charge normally
      billingIncrement = plan.price_per_pdf;
    }
    
    // Update total_pdf_count in Users table
    try {
      await updateItem(
        USERS_TABLE,
        { user_id: userId },
        'SET total_pdf_count = if_not_exists(total_pdf_count, :zero) + :inc',
        { ':zero': 0, ':inc': 1 }
      );
    } catch (error) {
      // If user_id update fails, try with actual user_id from user object
      if (user.user_id && user.user_id !== userId) {
        await updateItem(
          USERS_TABLE,
          { user_id: user.user_id },
          'SET total_pdf_count = if_not_exists(total_pdf_count, :zero) + :inc',
          { ':zero': 0, ':inc': 1 }
        );
      } else {
        logger.warn('Could not increment PDF count in Users table', {
          userSub,
          userId,
          error: error.message,
        });
      }
    }
    
    // For paid plans, create or update bill record in Bills table (only if charging)
    if (isPaidPlan && billingIncrement > 0) {
      try {
        // Try to get existing bill for this month
        const { getItem } = require('./dynamodb');
        const existingBill = await getItem(BILLS_TABLE, {
          user_id: userId,
          billing_month: currentMonth,
        });
        
        if (existingBill) {
          // Update existing bill
          await updateItem(
            BILLS_TABLE,
            {
              user_id: userId,
              billing_month: currentMonth,
            },
            'SET monthly_pdf_count = monthly_pdf_count + :inc, monthly_billing_amount = monthly_billing_amount + :billing, updated_at = :updated_at',
            {
              ':inc': 1,
              ':billing': billingIncrement,
              ':updated_at': nowISO,
            }
          );
        } else {
          // Create new bill record for this month
          await putItem(BILLS_TABLE, {
            user_id: userId,
            billing_month: currentMonth,
            monthly_pdf_count: 1,
            monthly_billing_amount: billingIncrement,
            is_paid: false,
            created_at: nowISO,
            updated_at: nowISO,
          });
        }
      } catch (error) {
        logger.error('Error updating bill record', {
          error: error.message,
          userSub,
          userId,
          billingMonth: currentMonth,
        });
        // Don't throw - bill tracking is not critical for PDF generation
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

