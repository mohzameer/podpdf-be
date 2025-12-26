/**
 * Accounts handler
 * Handles: POST /accounts, GET /accounts/me, DELETE /accounts/me, PUT /accounts/me/webhook
 */

const logger = require('../utils/logger');
const { Unauthorized, Forbidden, InternalServerError, BadRequest } = require('../utils/errors');
const { extractUserSub } = require('../middleware/auth');
const { getUserAccount, validateUserAndPlan } = require('../services/business');
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
    } else if (method === 'GET' && path === '/accounts/me/bills') {
      return await getBills(event);
    } else if (method === 'DELETE' && path === '/accounts/me') {
      return await deleteAccount(event);
    } else if (method === 'PUT' && path === '/accounts/me/webhook') {
      return await updateWebhook(event);
    } else if (method === 'PUT' && path === '/accounts/me/upgrade') {
      return await upgradeToPaidPlan(event);
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
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'INVALID_REQUEST_BODY',
            message: 'Invalid JSON in request body',
          },
        }),
      };
    }

    const { user_sub, email, name, plan_id } = body;

    // Validate required fields
    if (!user_sub || typeof user_sub !== 'string' || !user_sub.trim()) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'MISSING_USER_SUB',
            message: 'user_sub field is required',
          },
        }),
      };
    }

    if (!email || typeof email !== 'string' || !email.trim()) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'MISSING_EMAIL',
            message: 'email field is required',
          },
        }),
      };
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
 * PUT /accounts/me/webhook - Update webhook URL
 */
async function updateWebhook(event) {
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

    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return BadRequest.INVALID_WEBHOOK_URL();
    }

    const { webhook_url } = body;

    // Validate webhook URL
    if (webhook_url) {
      const validation = validateWebhookUrl(webhook_url);
      if (!validation.isValid) {
        return validation.error;
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

    logger.info('Webhook URL updated', { userId: user.user_id, webhookUrl: webhook_url });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: user.user_id,
        webhook_url: webhook_url || null,
        updated_at: new Date().toISOString(),
      }),
    };
  } catch (error) {
    logger.error('Error updating webhook', { error: error.message });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * GET /accounts/me/billing - Get monthly billing information
 */
async function getBilling(event) {
  try {
    const userSub = extractUserSub(event);

    // Get user account
    const user = await getUserAccount(userSub);
    if (!user) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Get plan to check if user is on paid plan
    const { getPlan } = require('../services/business');
    const planId = user.plan_id || 'free-basic';
    const plan = await getPlan(planId);

    const isPaidPlan = plan && plan.type === 'paid';

    // Get current month
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Build billing response
    const billing = {
      plan_id: planId,
      plan_type: plan?.type || 'free',
      billing_month: currentMonth,
      monthly_billing_amount: 0,
      pdf_count: 0, // All-time for free, current month for paid
      price_per_pdf: plan?.price_per_pdf || 0,
      is_paid: false,
    };

    if (isPaidPlan && user.user_id) {
      // For paid plans: show current month's count and billing
      try {
        const { getItem } = require('../services/dynamodb');
        const BILLS_TABLE = process.env.BILLS_TABLE;
        const currentBill = await getItem(BILLS_TABLE, {
          user_id: user.user_id,
          billing_month: currentMonth,
        });

        if (currentBill) {
          billing.monthly_billing_amount = currentBill.monthly_billing_amount || 0;
          billing.pdf_count = currentBill.monthly_pdf_count || 0; // Current month count
          billing.is_paid = currentBill.is_paid || false;
        }
      } catch (error) {
        logger.error('Error getting bill from Bills table', {
          error: error.message,
          userSub,
          userId: user.user_id,
        });
        // Continue with default values (0)
      }
    } else {
      // For free plans: show all-time count
      billing.pdf_count = user.total_pdf_count || 0; // All-time count
    }

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
 * GET /accounts/me/bills - Get list of all bills/invoices for the user
 */
async function getBills(event) {
  try {
    const userSub = extractUserSub(event);

    // Get user account
    const user = await getUserAccount(userSub);
    if (!user) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Get plan to check if user is on paid plan
    const { getPlan } = require('../services/business');
    const planId = user.plan_id || 'free-basic';
    const plan = await getPlan(planId);

    const isPaidPlan = plan && plan.type === 'paid';

    // Build response
    const response = {
      plan_id: planId,
      plan_type: plan?.type || 'free',
      bills: [],
    };

    // For paid plans, query all bills from Bills table
    if (isPaidPlan && user.user_id) {
      try {
        const { queryItems } = require('../services/dynamodb');
        const BILLS_TABLE = process.env.BILLS_TABLE;
        
        // Query all bills for this user using primary key (user_id is partition key)
        const bills = await queryItems(
          BILLS_TABLE,
          'user_id = :user_id',
          { ':user_id': user.user_id },
          null // No GSI needed - querying primary key directly
        );

        // Sort bills by billing_month descending (most recent first)
        const sortedBills = (bills || []).sort((a, b) => {
          if (a.billing_month > b.billing_month) return -1;
          if (a.billing_month < b.billing_month) return 1;
          return 0;
        });

        // Format bills for response (exclude internal fields)
        response.bills = sortedBills.map(bill => ({
          billing_month: bill.billing_month,
          monthly_pdf_count: bill.monthly_pdf_count || 0,
          monthly_billing_amount: bill.monthly_billing_amount || 0,
          is_paid: bill.is_paid || false,
          bill_id: bill.bill_id || null,
          invoice_id: bill.invoice_id || null,
          paid_at: bill.paid_at || null,
          created_at: bill.created_at,
          updated_at: bill.updated_at,
        }));
      } catch (error) {
        logger.error('Error getting bills from Bills table', {
          error: error.message,
          userSub,
          userId: user.user_id,
        });
        // Continue with empty bills array
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(response),
    };
  } catch (error) {
    logger.error('Error getting bills list', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * PUT /accounts/me/upgrade - Upgrade user to paid plan
 */
async function upgradeToPaidPlan(event) {
  try {
    const userSub = extractUserSub(event);

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
      await updateItem(
        USERS_TABLE,
        { user_id: user.user_id },
        'SET plan_id = :plan_id, account_status = :status, quota_exceeded = :false, upgraded_at = :upgraded_at',
        {
          ':plan_id': plan_id,
          ':status': 'paid',
          ':false': false,
          ':upgraded_at': nowISO,
        }
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

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Account upgraded successfully',
        plan: {
          plan_id: plan.plan_id,
          name: plan.name,
          type: plan.type,
          price_per_pdf: plan.price_per_pdf,
        },
        upgraded_at: nowISO,
      }),
    };
  } catch (error) {
    logger.error('Error upgrading account', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

module.exports = { handler };

