/**
 * Business Logic Service
 * Handles rate limiting, quota checking, and plan management
 */

const { getItem, updateItem, putItem } = require('./dynamodb');
const { Forbidden, BadRequest, InternalServerError } = require('../utils/errors');
const logger = require('../utils/logger');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const USERS_TABLE = process.env.USERS_TABLE;
const USER_RATE_LIMITS_TABLE = process.env.USER_RATE_LIMITS_TABLE;
const PLANS_TABLE = process.env.PLANS_TABLE;
const CREDIT_TRANSACTIONS_TABLE = process.env.CREDIT_TRANSACTIONS_TABLE;
const CREDIT_DEDUCTION_QUEUE_URL = process.env.CREDIT_DEDUCTION_QUEUE_URL;
const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '20', 10);
const FREE_TIER_QUOTA = parseInt(process.env.FREE_TIER_QUOTA || '100', 10);

const sqsClient = new SQSClient({ region: process.env.AWS_REGION || 'eu-central-1' });

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
    // Normalize plan type for comparison (handle string/number/undefined cases)
    const planType = plan?.type ? String(plan.type).toLowerCase().trim() : null;
    const isPaidPlan = planType === 'paid';

    // If plan type is paid or plan has no monthly quota (paid tier), allow
    if (isPaidPlan || plan.monthly_quota === null || plan.monthly_quota === undefined) {
      // Only clear quota_exceeded flag if plan type is explicitly paid
      if (isPaidPlan && user.quota_exceeded && user.user_id) {
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
      if (isPaidPlan) {
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
 * Check if conversion type is enabled for the plan
 * @param {object} plan - Plan configuration
 * @param {string} inputType - Requested input type ('html', 'markdown', 'image')
 * @returns {Promise<{allowed: boolean, error: object|null}>}
 */
async function checkConversionType(plan, inputType) {
  try {
    // If plan doesn't have enabled_conversion_types, allow all (backward compatible)
    if (!plan.enabled_conversion_types || 
        plan.enabled_conversion_types === null || 
        (Array.isArray(plan.enabled_conversion_types) && plan.enabled_conversion_types.length === 0)) {
      return { allowed: true, error: null };
    }

    // Normalize input type to lowercase
    const normalizedInputType = inputType.toLowerCase();

    // Check if input type is in enabled list
    const enabledTypes = plan.enabled_conversion_types.map(t => t.toLowerCase());
    if (enabledTypes.includes(normalizedInputType)) {
      return { allowed: true, error: null };
    }

    // Conversion type not enabled
    return {
      allowed: false,
      error: Forbidden.CONVERSION_TYPE_NOT_ENABLED(
        normalizedInputType,
        enabledTypes
      ),
    };
  } catch (error) {
    logger.error('Conversion type check error', {
      error: error.message,
      inputType,
    });
    // On error, allow the request (fail open)
    return { allowed: true, error: null };
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

/**
 * Check if user has sufficient credits for PDF generation
 * @param {string} userId - User ID (ULID)
 * @param {object} plan - User's plan configuration
 * @param {number} costPerPdf - Cost per PDF (from plan.price_per_pdf)
 * @returns {Promise<{allowed: boolean, error: object|null, currentBalance: number}>}
 */
async function checkCredits(userId, plan, costPerPdf) {
  try {
    // Free tier users don't need credits
    if (!plan || plan.type !== 'paid' || !costPerPdf || costPerPdf <= 0) {
      return { allowed: true, error: null, currentBalance: null };
    }

    // Get user account
    const user = await getItem(USERS_TABLE, { user_id: userId });
    if (!user) {
      logger.warn('User not found for credit check', { userId });
      return {
        allowed: false,
        error: Forbidden.ACCOUNT_NOT_FOUND(),
        currentBalance: null,
      };
    }

    // Check if plan has free credits and user has remaining free credits
    const hasFreeCredits = plan.free_credits && plan.free_credits > 0;
    const freeCreditsRemaining = user.free_credits_remaining || 0;

    // If user has free credits remaining, allow (free credits are consumed first)
    if (hasFreeCredits && freeCreditsRemaining > 0) {
      return { allowed: true, error: null, currentBalance: user.credits_balance || 0 };
    }

    // Check prepaid credits balance
    const creditsBalance = user.credits_balance || 0;

    if (creditsBalance < costPerPdf) {
      return {
        allowed: false,
        error: Forbidden.INSUFFICIENT_CREDITS(creditsBalance, costPerPdf),
        currentBalance: creditsBalance,
      };
    }

    return { allowed: true, error: null, currentBalance: creditsBalance };
  } catch (error) {
    logger.error('Error checking credits', {
      error: error.message,
      userId,
    });
    // On error, allow the request (fail open) - but log the error
    return { allowed: true, error: null, currentBalance: null };
  }
}

/**
 * Queue credit deduction message to SQS FIFO queue
 * Only called after PDF is successfully generated
 * @param {string} userId - User ID (ULID)
 * @param {string} jobId - Job ID (UUID)
 * @param {number} amount - Amount to deduct (cost per PDF)
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
async function queueCreditDeduction(userId, jobId, amount) {
  try {
    if (!CREDIT_DEDUCTION_QUEUE_URL) {
      logger.error('Credit deduction queue URL not configured', { userId, jobId });
      return { success: false, error: 'queue_not_configured' };
    }

    // Prepare SQS message for FIFO queue
    // MessageGroupId = user_id (ensures sequential processing per user)
    // MessageDeduplicationId = job_id (FIFO deduplication prevents duplicate processing)
    const messageBody = {
      user_id: userId,
      amount: amount,
      job_id: jobId,
      timestamp: Date.now(),
    };

    const command = new SendMessageCommand({
      QueueUrl: CREDIT_DEDUCTION_QUEUE_URL,
      MessageBody: JSON.stringify(messageBody),
      MessageGroupId: userId, // Sequential processing per user
      MessageDeduplicationId: jobId, // Deduplication by job_id
    });

    await sqsClient.send(command);

    logger.info('Credit deduction queued', {
      userId,
      jobId,
      amount,
    });

    return { success: true, error: null };
  } catch (error) {
    logger.error('Error queueing credit deduction', {
      error: error.message,
      userId,
      jobId,
      amount,
    });
    // Don't throw - if queue fails, PDF is lost but customer not charged (acceptable)
    return { success: false, error: error.message };
  }
}

/**
 * Purchase credits for a user
 * Atomically adds credits to user's balance and logs transaction
 * Automatically upgrades free plan users to paid plan on first purchase
 * @param {string} userId - User ID
 * @param {number} amount - Amount to add (must be positive)
 * @param {object} metadata - Optional metadata (reference_id, payment_provider)
 * @returns {Promise<{success: boolean, newBalance: number, transactionId: string, upgraded: boolean, plan: object|null, error: object|null}>}
 */
async function purchaseCredits(userId, amount, metadata = null) {
  try {
    // Validate amount
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return {
        success: false,
        newBalance: null,
        transactionId: null,
        upgraded: false,
        plan: null,
        error: BadRequest.INVALID_PARAMETER('amount', 'Amount must be a positive number'),
      };
    }

    // Get user account
    const user = await getItem(USERS_TABLE, { user_id: userId });
    if (!user) {
      return {
        success: false,
        newBalance: null,
        transactionId: null,
        upgraded: false,
        plan: null,
        error: Forbidden.ACCOUNT_NOT_FOUND(),
      };
    }

    // Check if user is on a free plan and needs to be upgraded
    const currentPlanId = user.plan_id || 'free-basic';
    const currentPlan = await getPlan(currentPlanId);
    const isFreePlan = !currentPlan || currentPlan.type !== 'paid';
    let upgraded = false;
    let upgradePlan = null;
    const DEFAULT_PAID_PLAN = 'paid-standard';

    // If user is on free plan, upgrade them to paid-standard
    if (isFreePlan) {
      const paidPlan = await getPlan(DEFAULT_PAID_PLAN);
      if (!paidPlan || paidPlan.type !== 'paid' || !paidPlan.is_active) {
        logger.error('Default paid plan not found or inactive', {
          userId,
          defaultPlanId: DEFAULT_PAID_PLAN,
        });
        return {
          success: false,
          newBalance: null,
          transactionId: null,
          upgraded: false,
          plan: null,
          error: InternalServerError.GENERIC('Default paid plan not available'),
        };
      }

      upgradePlan = paidPlan;
      upgraded = true;
    }

    const currentBalance = user.credits_balance || 0;
    const nowISO = new Date().toISOString();

    // Build update expression for credits and optional upgrade
    let updateExpression = 'SET credits_balance = if_not_exists(credits_balance, :zero) + :amount, credits_last_updated_at = :now';
    const expressionAttributeValues = {
      ':zero': 0,
      ':amount': amount,
      ':now': nowISO,
    };

    // If upgrading, add plan upgrade fields
    if (upgraded) {
      updateExpression += ', plan_id = :plan_id, account_status = :status, quota_exceeded = :false, upgraded_at = :upgraded_at';
      expressionAttributeValues[':plan_id'] = DEFAULT_PAID_PLAN;
      expressionAttributeValues[':status'] = 'paid';
      expressionAttributeValues[':false'] = false;
      expressionAttributeValues[':upgraded_at'] = nowISO;

      // Initialize free_credits_remaining if plan has free credits
      if (upgradePlan.free_credits && upgradePlan.free_credits > 0) {
        updateExpression += ', free_credits_remaining = if_not_exists(free_credits_remaining, :zero_credits) + :credits';
        expressionAttributeValues[':zero_credits'] = 0;
        expressionAttributeValues[':credits'] = upgradePlan.free_credits;
      }
    }

    // Atomically update credits_balance (and upgrade if needed)
    const updatedUser = await updateItem(
      USERS_TABLE,
      { user_id: userId },
      updateExpression,
      expressionAttributeValues
    );

    // Log transaction to CreditTransactions table
    const { generateULID } = require('../utils/ulid');
    const transactionId = generateULID();

    const transactionRecord = {
      transaction_id: transactionId,
      user_id: userId,
      amount: amount, // Positive for purchases
      transaction_type: 'purchase',
      status: 'completed',
      created_at: nowISO,
      processed_at: nowISO,
    };

    // Add optional metadata fields if provided
    if (metadata?.reference_id) {
      transactionRecord.reference_id = metadata.reference_id;
    }
    if (metadata?.payment_provider) {
      transactionRecord.payment_provider = metadata.payment_provider;
    }
    if (metadata?.price_id) {
      transactionRecord.price_id = metadata.price_id;
    }

    await putItem(CREDIT_TRANSACTIONS_TABLE, transactionRecord);

    logger.info('Credits purchased', {
      userId,
      amount,
      oldBalance: currentBalance,
      newBalance: updatedUser.credits_balance,
      transactionId,
      upgraded,
      planId: upgraded ? DEFAULT_PAID_PLAN : currentPlanId,
    });

    return {
      success: true,
      newBalance: updatedUser.credits_balance,
      transactionId,
      upgraded,
      plan: upgraded ? {
        plan_id: upgradePlan.plan_id,
        name: upgradePlan.name,
        type: upgradePlan.type,
        price_per_pdf: upgradePlan.price_per_pdf,
        free_credits: upgradePlan.free_credits || 0,
      } : null,
      error: null,
    };
  } catch (error) {
    logger.error('Error purchasing credits', {
      error: error.message,
      userId,
      amount,
    });
    return {
      success: false,
      newBalance: null,
      transactionId: null,
      upgraded: false,
      plan: null,
      error: InternalServerError.GENERIC('Failed to purchase credits'),
    };
  }
}

module.exports = {
  getUserAccount,
  getPlan,
  checkRateLimit,
  checkQuota,
  checkConversionType,
  checkCredits,
  queueCreditDeduction,
  validateUserAndPlan,
  purchaseCredits,
};

