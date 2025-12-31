/**
 * Plans handler
 * GET /plans/{plan_id} - Get plan details
 * GET /plans - List all active plans
 */

const logger = require('../utils/logger');
const { NotFound, InternalServerError } = require('../utils/errors');
const { getPlan } = require('../services/business');
const { scan } = require('../services/dynamodb');

const PLANS_TABLE = process.env.PLANS_TABLE;

/**
 * Plans handler
 * @param {object} event - API Gateway event
 * @returns {object} API Gateway response
 */
async function handler(event) {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.requestContext?.http?.path || event.path;
    const pathParameters = event.pathParameters || {};

    logger.info('Plans handler invoked', { method, path });

    if (method === 'GET' && pathParameters.plan_id) {
      return await getPlanDetails(event, pathParameters.plan_id);
    } else if (method === 'GET' && path === '/plans') {
      return await listPlans(event);
    } else {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: 'Method not allowed',
          },
        }),
      };
    }
  } catch (error) {
    logger.error('Error in plans handler', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * GET /plans/{plan_id} - Get plan details
 */
async function getPlanDetails(event, planId) {
  try {
    if (!planId) {
      return NotFound('Plan ID is required');
    }

    const plan = await getPlan(planId);

    if (!plan) {
      return NotFound(`Plan not found: ${planId}`);
    }

    // Filter out internal fields if needed, or return all
    const planResponse = {
      plan_id: plan.plan_id,
      name: plan.name,
      type: plan.type,
      monthly_quota: plan.monthly_quota ?? null,
      price_per_pdf: plan.price_per_pdf ?? 0,
      rate_limit_per_minute: plan.rate_limit_per_minute ?? null,
      enabled_conversion_types: plan.enabled_conversion_types ?? null,
      description: plan.description ?? null,
      is_active: plan.is_active ?? true,
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: planResponse,
      }),
    };
  } catch (error) {
    logger.error('Error getting plan details', {
      error: error.message,
      planId,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * GET /plans - List all active plans
 */
async function listPlans(event) {
  try {
    // Scan all plans from the table
    const plans = await scan(PLANS_TABLE);

    // Filter to only active plans and format response
    const activePlans = (plans || [])
      .filter(plan => plan.is_active !== false) // Include if is_active is true or undefined
      .map(plan => ({
        plan_id: plan.plan_id,
        name: plan.name,
        type: plan.type,
        monthly_quota: plan.monthly_quota ?? null,
        price_per_pdf: plan.price_per_pdf ?? 0,
        rate_limit_per_minute: plan.rate_limit_per_minute ?? null,
        enabled_conversion_types: plan.enabled_conversion_types ?? null,
        description: plan.description ?? null,
        is_active: plan.is_active ?? true,
      }))
      .sort((a, b) => {
        // Sort by type (free first) then by name
        if (a.type !== b.type) {
          return a.type === 'free' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plans: activePlans,
        count: activePlans.length,
      }),
    };
  } catch (error) {
    logger.error('Error listing plans', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

module.exports = { handler };

