/**
 * Accounts handler
 * Handles: POST /accounts, GET /accounts/me, DELETE /accounts/me, PUT /accounts/me/webhook (DEPRECATED)
 * 
 * Note: PUT /accounts/me/webhook is deprecated. Use the webhook-manager handler for webhook management.
 */

const logger = require('../utils/logger');
const { Unauthorized, Forbidden, InternalServerError, BadRequest } = require('../utils/errors');
const { extractUserSub } = require('../middleware/auth');
const { getUserAccount, validateUserAndPlan, purchaseCredits: purchaseCreditsService } = require('../services/business');
const { generateULID } = require('../utils/ulid');
const { putItem, updateItem, deleteItem } = require('../services/dynamodb');
const { validateWebhookUrl } = require('../services/validation');

const USERS_TABLE = process.env.USERS_TABLE;

/**
 * Main handler - routes to appropriate function based on HTTP method and path
 */
async function handler(event) {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.requestContext?.http?.path || event.path;

    logger.info('Accounts handler invoked', { method, path });

    if (method === 'POST' && path === '/accounts') {
      return await createAccount(event);
    } else if (method === 'GET' && path === '/accounts/me') {
      return await getAccount(event);
    } else if (method === 'GET' && path === '/accounts/me/billing') {
      return await getBilling(event);
    } else if (method === 'DELETE' && path === '/accounts/me') {
      return await deleteAccount(event);
    } else if (method === 'PUT' && path === '/accounts/me/webhook') {
      return await updateWebhook(event);
    } else if (method === 'PUT' && path === '/accounts/me/upgrade') {
      return await upgradeToPaidPlan(event);
    } else if (method === 'POST' && path === '/accounts/me/credits/purchase') {
      return await purchaseCredits(event);
    }

    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    logger.error('Accounts handler error', { error: error.message, stack: error.stack });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * POST /accounts - Create account record in DynamoDB
 * Note: Called after user signs up via Amplify. No JWT required.
 */
async function createAccount(event) {
  try {
    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return BadRequest.INVALID_PARAMETER('body', 'Invalid JSON in request body');
    }

    const { user_sub, email, name, plan_id } = body;

    // Validate required fields
    if (!user_sub || typeof user_sub !== 'string' || !user_sub.trim()) {
      return BadRequest.INVALID_PARAMETER('user_sub', 'user_sub field is required');
    }

    if (!email || typeof email !== 'string' || !email.trim()) {
      return BadRequest.INVALID_PARAMETER('email', 'email field is required');
    }

    // Check if account already exists
    const existingUser = await getUserAccount(user_sub);
    if (existingUser) {
      return Forbidden.ACCOUNT_ALREADY_EXISTS();
    }

    // Generate user ID (ULID)
    const userId = generateULID();

    // Create user record in DynamoDB
    const now = new Date().toISOString();
    const userRecord = {
      user_id: userId,
      user_sub: user_sub.trim(),
      email: email.trim(),
      display_name: name && typeof name === 'string' && name.trim() ? name.trim() : null,
      plan_id: plan_id || 'free-basic',
      account_status: 'free',
      total_pdf_count: 0,
      created_at: now,
    };

    await putItem(USERS_TABLE, userRecord);

    logger.info('Account created', { userId, userSub: user_sub, email });

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        email: userRecord.email,
        display_name: userRecord.display_name,
        plan_id: userRecord.plan_id,
        account_status: userRecord.account_status,
        created_at: userRecord.created_at,
      }),
  };
  } catch (error) {
    logger.error('Error creating account', { error: error.message, stack: error.stack });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * GET /accounts/me - Get account info
 */
async function getAccount(event) {
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

    const user = await getUserAccount(userSub);
    if (!user) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Return user info (excluding sensitive data)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: user.user_id,
        email: user.email,
        display_name: user.display_name || null,
        plan_id: user.plan_id,
        account_status: user.account_status,
        total_pdf_count: user.total_pdf_count || 0,
        free_credits_remaining: user.free_credits_remaining ?? null,
        quota_exceeded: user.quota_exceeded || false,
        webhook_url: user.webhook_url || null,
        created_at: user.created_at,
        upgraded_at: user.upgraded_at || null,
      }),
  };
  } catch (error) {
    logger.error('Error getting account', { error: error.message });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * DELETE /accounts/me - Delete account
 */
async function deleteAccount(event) {
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

    const user = await getUserAccount(userSub);
    if (!user) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Delete user record
    await deleteItem(USERS_TABLE, { user_id: user.user_id });

    logger.info('Account deleted', { userId: user.user_id, userSub });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Account deleted successfully',
      }),
    };
  } catch (error) {
    logger.error('Error deleting account', { error: error.message });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * PUT /accounts/me/webhook - Update webhook URL (DEPRECATED)
 * 
 * @deprecated This endpoint is deprecated. Use the new multiple webhooks system instead:
 * - POST /accounts/me/webhooks - Create a new webhook
 * - PUT /accounts/me/webhooks/{webhook_id} - Update a webhook
 * 
 * This endpoint will be removed in a future version. Please migrate to the new webhook management API.
 */
async function updateWebhook(event) {
  try {
    // Log deprecation warning
    logger.warn('Deprecated endpoint used: PUT /accounts/me/webhook. Please migrate to the new webhook management API at /accounts/me/webhooks');

    const userSub = await extractUserSub(event);
    if (!userSub) {
  return {
        statusCode: 401,
    headers: { 
          'Content-Type': 'application/json',
          'Deprecation': 'true',
          'Sunset': 'Mon, 01 Jan 2026 00:00:00 GMT',
          'Link': '</accounts/me/webhooks>; rel="successor-version"',
        },
        body: JSON.stringify({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid JWT token',
          },
        }),
      };
    }

    const user = await getUserAccount(userSub);
    if (!user) {
      const errorResponse = Forbidden.ACCOUNT_NOT_FOUND();
      errorResponse.headers = {
        ...errorResponse.headers,
        'Deprecation': 'true',
        'Sunset': 'Mon, 01 Jan 2026 00:00:00 GMT',
        'Link': '</accounts/me/webhooks>; rel="successor-version"',
      };
      return errorResponse;
    }

    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      const errorResponse = BadRequest.INVALID_WEBHOOK_URL();
      errorResponse.headers = {
        ...errorResponse.headers,
        'Deprecation': 'true',
        'Sunset': 'Mon, 01 Jan 2026 00:00:00 GMT',
        'Link': '</accounts/me/webhooks>; rel="successor-version"',
      };
      return errorResponse;
    }

    const { webhook_url } = body;

    // Validate webhook URL
    if (webhook_url) {
      const validation = validateWebhookUrl(webhook_url);
      if (!validation.isValid) {
        const errorResponse = validation.error;
        errorResponse.headers = {
          ...errorResponse.headers,
          'Deprecation': 'true',
          'Sunset': 'Mon, 01 Jan 2026 00:00:00 GMT',
          'Link': '</accounts/me/webhooks>; rel="successor-version"',
        };
        return errorResponse;
      }
    }

    // Update user record
    await updateItem(
      USERS_TABLE,
      { user_id: user.user_id },
      'SET webhook_url = :webhook_url, updated_at = :updated_at',
      {
        ':webhook_url': webhook_url || null,
        ':updated_at': new Date().toISOString(),
      }
    );

    logger.info('Webhook URL updated (deprecated endpoint)', { userId: user.user_id, webhookUrl: webhook_url });

    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Deprecation': 'true',
        'Sunset': 'Mon, 01 Jan 2026 00:00:00 GMT',
        'Link': '</accounts/me/webhooks>; rel="successor-version"',
      },
      body: JSON.stringify({
        user_id: user.user_id,
        webhook_url: webhook_url || null,
        updated_at: new Date().toISOString(),
        _deprecated: true,
        _deprecation_message: 'This endpoint is deprecated. Please use POST /accounts/me/webhooks to create webhooks instead.',
        _migration_guide: 'See https://docs.podpdf.com/webhooks for migration guide',
      }),
    };
  } catch (error) {
    logger.error('Error updating webhook', { error: error.message });
    const errorResponse = InternalServerError.GENERIC(error.message);
    errorResponse.headers = {
      ...errorResponse.headers,
      'Deprecation': 'true',
      'Sunset': 'Mon, 01 Jan 2026 00:00:00 GMT',
      'Link': '</accounts/me/webhooks>; rel="successor-version"',
    };
    return errorResponse;
  }
}

/**
 * GET /accounts/me/billing - Get credit-based billing information
 */
async function getBilling(event) {
  try {
    const userSub = await extractUserSub(event);

    // Get user account
    const user = await getUserAccount(userSub);
    if (!user) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Get plan to check if user is on paid plan
    const { getPlan } = require('../services/business');
    const planId = user.plan_id || 'free-basic';
    const plan = await getPlan(planId);

    // Get all data directly from Users table (no queries needed)
    const credits_balance = user.credits_balance || 0;
    const total_pdf_count = user.total_pdf_count || 0;
    const free_credits_remaining = user.free_credits_remaining || 0;

    // Get price_per_pdf from plan
    const price_per_pdf = plan?.price_per_pdf || 0;
    const isPaidPlan = plan && plan.type === 'paid';

    // Calculate total_amount = total_pdf_count × price_per_pdf (for paid users)
    // This represents the current value of all PDFs generated at current price
    const total_amount = isPaidPlan ? total_pdf_count * price_per_pdf : 0;

    // Build billing response
    const billing = {
      plan_id: planId,
      plan_type: plan?.type || 'free',
      credits_balance: credits_balance,
      free_credits_remaining: free_credits_remaining,
      total_pdf_count: total_pdf_count, // Total PDFs generated (all-time)
      total_amount: total_amount, // Total amount (total_pdf_count × price_per_pdf for paid users)
      price_per_pdf: price_per_pdf,
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        billing,
      }),
    };
  } catch (error) {
    logger.error('Error getting billing information', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * PUT /accounts/me/upgrade - Upgrade user to paid plan
 * @deprecated This endpoint is deprecated. Users are automatically upgraded to paid plan when they purchase credits.
 */
async function upgradeToPaidPlan(event) {
  // Log deprecation warning
  logger.warn('Deprecated endpoint used: PUT /accounts/me/upgrade. Users are now automatically upgraded when purchasing credits via POST /accounts/me/credits/purchase');
  try {
    const userSub = await extractUserSub(event);

    // Get user account
    const user = await getUserAccount(userSub);
    if (!user) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return BadRequest.INVALID_PLAN_ID('missing');
    }

    // Validate plan_id is provided
    const { plan_id } = body;
    if (!plan_id || typeof plan_id !== 'string') {
      return BadRequest.INVALID_PLAN_ID(plan_id || 'missing');
    }

    // Get plan configuration
    const { getPlan } = require('../services/business');
    const plan = await getPlan(plan_id);

    if (!plan) {
      return BadRequest.INVALID_PLAN_ID(plan_id);
    }

    // Validate plan is a paid plan
    if (plan.type !== 'paid') {
      return BadRequest.INVALID_PLAN_ID(plan_id, 'Plan must be a paid plan');
    }

    // Validate plan is active
    if (!plan.is_active) {
      return BadRequest.INVALID_PLAN_ID(plan_id, 'Plan is not active');
    }

    // Update user to paid plan
    const nowISO = new Date().toISOString();
    try {
      // Build update expression
      let updateExpression = 'SET plan_id = :plan_id, account_status = :status, quota_exceeded = :false, upgraded_at = :upgraded_at';
      const expressionAttributeValues = {
        ':plan_id': plan_id,
        ':status': 'paid',
        ':false': false,
        ':upgraded_at': nowISO,
      };
      
      // Initialize free_credits_remaining if plan has free credits
      if (plan.free_credits && plan.free_credits > 0) {
        updateExpression += ', free_credits_remaining = if_not_exists(free_credits_remaining, :zero) + :credits';
        expressionAttributeValues[':zero'] = 0;
        expressionAttributeValues[':credits'] = plan.free_credits;
      }
      
      await updateItem(
        USERS_TABLE,
        { user_id: user.user_id },
        updateExpression,
        expressionAttributeValues
      );
    } catch (error) {
      logger.error('Error upgrading user to paid plan', {
        error: error.message,
        userSub,
        userId: user.user_id,
        planId: plan_id,
      });
      return InternalServerError.GENERIC('Failed to upgrade account');
    }

    // Get updated user to return free_credits_remaining
    const updatedUser = await getUserAccount(userSub);
    
    const responseBody = {
      message: 'Account upgraded successfully',
      plan: {
        plan_id: plan.plan_id,
        name: plan.name,
        type: plan.type,
        price_per_pdf: plan.price_per_pdf,
        free_credits: plan.free_credits || 0,
      },
      free_credits_remaining: updatedUser?.free_credits_remaining ?? (plan.free_credits || 0),
      upgraded_at: nowISO,
      _deprecated: true,
      _deprecation_message: 'This endpoint is deprecated. Users are automatically upgraded to paid plan when purchasing credits via POST /accounts/me/credits/purchase',
    };

    return {
      statusCode: 200,
      headers: { 
        'Content-Type': 'application/json',
        'Deprecation': 'true',
        'Sunset': 'Mon, 01 Jan 2026 00:00:00 GMT',
        'Link': '</accounts/me/credits/purchase>; rel="successor-version"',
      },
      body: JSON.stringify(responseBody),
    };
  } catch (error) {
    logger.error('Error upgrading account', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * POST /accounts/me/credits/purchase - Purchase credits
 */
async function purchaseCredits(event) {
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

    // Get user account
    const user = await getUserAccount(userSub);
    if (!user) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return BadRequest.INVALID_PARAMETER('body', 'Invalid JSON in request body');
    }

    const { amount } = body;

    // Validate amount
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return BadRequest.INVALID_PARAMETER('amount', 'Amount must be a positive number');
    }

    // Purchase credits
    const result = await purchaseCreditsService(user.user_id, amount);

    if (!result.success) {
      return result.error;
    }

    logger.info('Credits purchased successfully', {
      userId: user.user_id,
      userSub,
      amount,
      newBalance: result.newBalance,
      transactionId: result.transactionId,
      upgraded: result.upgraded,
    });

    const responseBody = {
      message: 'Credits purchased successfully',
      credits_balance: result.newBalance,
      amount_purchased: amount,
      transaction_id: result.transactionId,
      purchased_at: new Date().toISOString(),
    };

    // Include upgrade information if user was upgraded
    if (result.upgraded && result.plan) {
      responseBody.upgraded = true;
      responseBody.plan = result.plan;
      responseBody.upgraded_at = new Date().toISOString();
      responseBody.message = 'Credits purchased successfully.';
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(responseBody),
    };
  } catch (error) {
    logger.error('Error purchasing credits', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

module.exports = { handler };

