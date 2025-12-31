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
 * Get the latest active bill for a user, creating a new one for current month if needed
 * @param {string} userId - User ID
 * @param {boolean} isPaidPlan - Whether user is on a paid plan (only create bill for paid plans)
 * @returns {Promise<object|null>} Latest active bill or null
 */
async function getLatestActiveBill(userId, isPaidPlan = false) {
  try {
    const { queryItems, getItem, putItem, updateItem } = require('../services/dynamodb');
    const BILLS_TABLE = process.env.BILLS_TABLE;
    
    // Get current month
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const nowISO = now.toISOString();
    
    // Query all bills for this user
    const bills = await queryItems(
      BILLS_TABLE,
      'user_id = :user_id',
      { ':user_id': userId },
      null
    );
    
    // Filter for active bills (is_active === true or undefined for backward compatibility)
    const activeBills = (bills || []).filter(bill => 
      bill.is_active === true || bill.is_active === undefined
    );
    
    // Check if there's an active bill for the current month
    const currentMonthBill = activeBills.find(bill => bill.billing_month === currentMonth);
    
    if (currentMonthBill) {
      // Return the current month's active bill
      return currentMonthBill;
    }
    
    // No active bill for current month - check if we need to create one
    if (isPaidPlan) {
      // Mark all previous month bills as inactive
      if (activeBills.length > 0) {
        try {
          for (const bill of activeBills) {
            if (bill.billing_month !== currentMonth) {
              await updateItem(
                BILLS_TABLE,
                {
                  user_id: userId,
                  billing_month: bill.billing_month,
                },
                'SET is_active = :false, updated_at = :updated_at',
                {
                  ':false': false,
                  ':updated_at': nowISO,
                }
              );
            }
          }
        } catch (error) {
          logger.warn('Error marking previous bills as inactive', {
            error: error.message,
            userId,
          });
          // Continue with bill creation even if marking inactive fails
        }
      }
      
      // Create new bill for current month
      try {
        const newBill = {
          user_id: userId,
          billing_month: currentMonth,
          monthly_pdf_count: 0,
          monthly_billing_amount: 0,
          is_paid: false,
          is_active: true,
          created_at: nowISO,
          updated_at: nowISO,
        };
        
        await putItem(BILLS_TABLE, newBill);
        return newBill;
      } catch (error) {
        logger.error('Error creating new bill', {
          error: error.message,
          userId,
          currentMonth,
        });
        return null;
      }
    }
    
    // For free plans or if no bills exist, return null
    return null;
  } catch (error) {
    logger.error('Error getting latest active bill', {
      error: error.message,
      userId,
    });
    return null;
  }
}

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
    } else if (method === 'GET' && path === '/accounts/me/stats') {
      return await getStats(event);
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
      // For paid plans: show latest active bill's count and billing
      try {
        const latestBill = await getLatestActiveBill(user.user_id, true);

        if (latestBill) {
          billing.billing_month = latestBill.billing_month;
          billing.monthly_billing_amount = latestBill.monthly_billing_amount || 0;
          billing.pdf_count = latestBill.monthly_pdf_count || 0;
          billing.is_paid = latestBill.is_paid || false;
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

        // Format bills for response - filter to show only active bills
        response.bills = sortedBills
          .filter(bill => bill.is_active === true || bill.is_active === undefined)
          .map(bill => ({
            billing_month: bill.billing_month,
            monthly_pdf_count: bill.monthly_pdf_count || 0,
            monthly_billing_amount: bill.monthly_billing_amount || 0,
            is_paid: bill.is_paid || false,
            is_active: bill.is_active !== false, // true or undefined (backward compatible)
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
 * GET /accounts/me/stats - Get total PDF count, monthly PDF count, and total amount
 * For free plans: returns total_pdf_count (all-time) from Users table, total_pdf_count_month (current month) from Bills table, amount is 0
 * For paid plans: returns total_pdf_count (current month) and total_pdf_count_month (current month) from Bills table, plus monthly billing amount
 */
async function getStats(event) {
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

    // Get plan to check if user is on paid plan
    const { getPlan } = require('../services/business');
    const planId = user.plan_id || 'free-basic';
    const plan = await getPlan(planId);

    // Normalize plan type for comparison
    const planType = plan?.type ? String(plan.type).toLowerCase().trim() : null;
    const isPaidPlan = planType === 'paid';

    // Get current month
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Build response
    const stats = {
      plan_id: planId,
      plan_type: plan?.type || 'free',
      total_pdf_count: 0,
      total_pdf_count_month: 0,
      total_amount: 0,
    };

    // Get latest active bill for both free and paid plans (to get monthly count)
    // Only create new bill for paid plans
    let latestBill = null;
    if (user.user_id) {
      latestBill = await getLatestActiveBill(user.user_id, isPaidPlan);
    }

    if (isPaidPlan) {
      // For paid plans: get latest active bill's stats from Bills table
      if (latestBill) {
        stats.total_pdf_count = latestBill.monthly_pdf_count || 0;
        stats.total_pdf_count_month = latestBill.monthly_pdf_count || 0;
        stats.total_amount = latestBill.monthly_billing_amount || 0;
      }
    } else {
      // For free plans: get all-time count from Users table, monthly count from latest active bill
      stats.total_pdf_count = user.total_pdf_count || 0;
      stats.total_pdf_count_month = latestBill ? (latestBill.monthly_pdf_count || 0) : 0;
      stats.total_amount = 0; // Free plans have no billing
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stats,
      }),
    };
  } catch (error) {
    logger.error('Error getting stats', {
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
          free_credits: plan.free_credits || 0,
        },
        free_credits_remaining: updatedUser?.free_credits_remaining ?? (plan.free_credits || 0),
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

