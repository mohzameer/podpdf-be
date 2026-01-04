/**
 * Webhook Service
 * Handles webhook CRUD operations and limit checking
 */

const { getItem, putItem, updateItem, deleteItem, query } = require('./dynamodb');
const { getUserAccount, getPlan } = require('./business');
const { generateULID } = require('../utils/ulid');
const { Forbidden, BadRequest } = require('../utils/errors');
const logger = require('../utils/logger');

const WEBHOOKS_TABLE = process.env.WEBHOOKS_TABLE;
const PLANS_TABLE = process.env.PLANS_TABLE;
const USERS_TABLE = process.env.USERS_TABLE;

const VALID_EVENT_TYPES = ['job.completed', 'job.failed', 'job.timeout', 'job.queued', 'job.processing'];
const DEFAULT_EVENTS = ['job.completed'];

/**
 * Get webhook limit for a plan
 * @param {object} plan - Plan configuration
 * @returns {number} Maximum webhooks allowed
 */
function getWebhookLimit(plan) {
  if (plan && plan.max_webhooks !== undefined && plan.max_webhooks !== null) {
    return plan.max_webhooks;
  }
  
  // Default limits based on plan type
  const planType = plan?.type ? String(plan.type).toLowerCase().trim() : 'free';
  if (planType === 'paid') {
    return 5;
  }
  return 1; // Free tier default
}

/**
 * Count existing webhooks for a user
 * @param {string} userId - User ID
 * @returns {Promise<number>} Number of webhooks
 */
async function countWebhooks(userId) {
  try {
    const result = await query(
      WEBHOOKS_TABLE,
      'user_id = :user_id',
      { ':user_id': userId },
      'UserIdIndex'
    );
    return result.Items ? result.Items.length : 0;
  } catch (error) {
    logger.error('Error counting webhooks', {
      error: error.message,
      userId,
    });
    return 0;
  }
}

/**
 * Check if user can create a new webhook
 * @param {string} userSub - Cognito user sub
 * @returns {Promise<{allowed: boolean, error: object|null, plan: object|null, currentCount: number, maxAllowed: number}>}
 */
async function checkWebhookLimit(userSub) {
  try {
    const user = await getUserAccount(userSub);
    if (!user) {
      return {
        allowed: false,
        error: Forbidden.ACCOUNT_NOT_FOUND(),
        plan: null,
        currentCount: 0,
        maxAllowed: 0,
      };
    }

    const planId = user.plan_id || 'free-basic';
    const plan = await getPlan(planId);
    
    if (!plan) {
      // Default to free plan if plan not found
      const defaultPlan = { type: 'free', max_webhooks: 1 };
      const currentCount = await countWebhooks(user.user_id);
      const maxAllowed = getWebhookLimit(defaultPlan);
      
      return {
        allowed: currentCount < maxAllowed,
        error: currentCount >= maxAllowed ? Forbidden.WEBHOOK_LIMIT_EXCEEDED(
          planId,
          'free',
          currentCount,
          maxAllowed
        ) : null,
        plan: defaultPlan,
        currentCount,
        maxAllowed,
      };
    }

    const currentCount = await countWebhooks(user.user_id);
    const maxAllowed = getWebhookLimit(plan);

    if (currentCount >= maxAllowed) {
      return {
        allowed: false,
        error: Forbidden.WEBHOOK_LIMIT_EXCEEDED(
          planId,
          plan.type || 'free',
          currentCount,
          maxAllowed
        ),
        plan,
        currentCount,
        maxAllowed,
      };
    }

    return {
      allowed: true,
      error: null,
      plan,
      currentCount,
      maxAllowed,
    };
  } catch (error) {
    logger.error('Error checking webhook limit', {
      error: error.message,
      userSub,
    });
    // Fail open - allow webhook creation on error
    return {
      allowed: true,
      error: null,
      plan: null,
      currentCount: 0,
      maxAllowed: 999,
    };
  }
}

/**
 * Validate event types
 * @param {array} events - Array of event type strings
 * @returns {object} Validation result
 */
function validateEvents(events) {
  if (!Array.isArray(events)) {
    return { isValid: false, error: 'Events must be an array' };
  }

  if (events.length === 0) {
    return { isValid: false, error: 'Events array cannot be empty' };
  }

  for (const event of events) {
    if (!VALID_EVENT_TYPES.includes(event)) {
      return {
        isValid: false,
        error: `Invalid event type: ${event}. Valid types: ${VALID_EVENT_TYPES.join(', ')}`,
      };
    }
  }

  return { isValid: true, error: null };
}

/**
 * Create a new webhook
 * @param {string} userSub - Cognito user sub
 * @param {object} webhookData - Webhook data (name, url, events, is_active)
 * @returns {Promise<object>} Created webhook
 */
async function createWebhook(userSub, webhookData) {
  try {
    const user = await getUserAccount(userSub);
    if (!user) {
      throw new Error('User not found');
    }

    // Check webhook limit
    const limitCheck = await checkWebhookLimit(userSub);
    if (!limitCheck.allowed) {
      throw limitCheck.error;
    }

    // Validate URL
    const { validateWebhookUrl } = require('./validation');
    const urlValidation = validateWebhookUrl(webhookData.url);
    if (!urlValidation.isValid) {
      throw urlValidation.error;
    }

    // Validate events
    const events = webhookData.events || DEFAULT_EVENTS;
    const eventsValidation = validateEvents(events);
    if (!eventsValidation.isValid) {
      return BadRequest.INVALID_PARAMETER('events', eventsValidation.error);
    }

    // Create webhook record
    const now = new Date().toISOString();
    const webhookId = generateULID();
    const isActive = webhookData.is_active !== undefined ? webhookData.is_active : true;
    const webhook = {
      webhook_id: webhookId,
      user_id: user.user_id,
      name: webhookData.name || null,
      url: webhookData.url,
      events: events,
      is_active: String(isActive), // Store as string for GSI compatibility
      created_at: now,
      updated_at: now,
      success_count: 0,
      failure_count: 0,
    };

    await putItem(WEBHOOKS_TABLE, webhook);

    logger.info('Webhook created', {
      webhookId,
      userId: user.user_id,
      url: webhookData.url,
    });

    // Return webhook without internal fields, convert is_active back to boolean
    const { user_id, ...responseWebhook } = webhook;
    responseWebhook.is_active = isActive;
    return responseWebhook;
  } catch (error) {
    logger.error('Error creating webhook', {
      error: error.message,
      userSub,
    });
    throw error;
  }
}

/**
 * Get a webhook by ID
 * @param {string} webhookId - Webhook ID
 * @returns {Promise<object|null>} Webhook or null
 */
async function getWebhook(webhookId) {
  try {
    const webhook = await getItem(WEBHOOKS_TABLE, { webhook_id: webhookId });
    return webhook;
  } catch (error) {
    logger.error('Error getting webhook', {
      error: error.message,
      webhookId,
    });
    return null;
  }
}

/**
 * Verify webhook belongs to user
 * @param {string} webhookId - Webhook ID
 * @param {string} userSub - Cognito user sub
 * @returns {Promise<{webhook: object|null, error: object|null}>}
 */
async function verifyWebhookOwnership(webhookId, userSub) {
  try {
    const user = await getUserAccount(userSub);
    if (!user) {
      return {
        webhook: null,
        error: Forbidden.ACCOUNT_NOT_FOUND(),
      };
    }

    const webhook = await getWebhook(webhookId);
    if (!webhook) {
      return {
        webhook: null,
        error: Forbidden.WEBHOOK_NOT_FOUND(),
      };
    }

    if (webhook.user_id !== user.user_id) {
      return {
        webhook: null,
        error: Forbidden.WEBHOOK_ACCESS_DENIED(),
      };
    }

    return {
      webhook,
      error: null,
    };
  } catch (error) {
    logger.error('Error verifying webhook ownership', {
      error: error.message,
      webhookId,
      userSub,
    });
    return {
      webhook: null,
      error: Forbidden.WEBHOOK_NOT_FOUND(),
    };
  }
}

/**
 * List webhooks for a user
 * @param {string} userSub - Cognito user sub
 * @param {object} filters - Filters (is_active, event, limit, next_token)
 * @returns {Promise<{webhooks: array, count: number, next_token: string|null}>}
 */
async function listWebhooks(userSub, filters = {}) {
  try {
    const user = await getUserAccount(userSub);
    if (!user) {
      throw new Error('User not found');
    }

    const isActive = filters.is_active;
    const eventFilter = filters.event;
    const limit = Math.min(filters.limit || 50, 100);
    const nextToken = filters.next_token;

    let indexName = 'UserIdIndex';
    let keyConditionExpression = 'user_id = :user_id';
    let expressionAttributeValues = { ':user_id': user.user_id };

    // Use UserIdStatusIndex if filtering by is_active
    if (isActive !== undefined) {
      indexName = 'UserIdStatusIndex';
      keyConditionExpression = 'user_id = :user_id AND is_active = :is_active';
      expressionAttributeValues[':is_active'] = String(isActive); // DynamoDB GSI requires string
    }

    const result = await query(
      WEBHOOKS_TABLE,
      keyConditionExpression,
      expressionAttributeValues,
      indexName,
      limit,
      nextToken ? JSON.parse(Buffer.from(nextToken, 'base64').toString()) : null
    );

    let webhooks = result.Items || [];

    // Filter by event type if specified
    if (eventFilter) {
      webhooks = webhooks.filter(wh => wh.events && wh.events.includes(eventFilter));
    }

    // Convert is_active back to boolean for response
    webhooks = webhooks.map(wh => ({
      ...wh,
      is_active: wh.is_active === 'true' || wh.is_active === true,
    }));

    // Remove user_id from response
    webhooks = webhooks.map(({ user_id, ...rest }) => rest);

    const responseNextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;

    return {
      webhooks,
      count: webhooks.length,
      next_token: responseNextToken,
    };
  } catch (error) {
    logger.error('Error listing webhooks', {
      error: error.message,
      userSub,
    });
    throw error;
  }
}

/**
 * Update a webhook
 * @param {string} webhookId - Webhook ID
 * @param {string} userSub - Cognito user sub
 * @param {object} updates - Fields to update (name, url, events, is_active)
 * @returns {Promise<object>} Updated webhook
 */
async function updateWebhook(webhookId, userSub, updates) {
  try {
    const { webhook, error } = await verifyWebhookOwnership(webhookId, userSub);
    if (error) {
      throw error;
    }

    const updateExpressions = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};

    if (updates.name !== undefined) {
      updateExpressions.push('#name = :name');
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = updates.name || null;
    }

    if (updates.url !== undefined) {
      // Validate URL
      const { validateWebhookUrl } = require('./validation');
      const urlValidation = validateWebhookUrl(updates.url);
      if (!urlValidation.isValid) {
        throw urlValidation.error;
      }
      updateExpressions.push('#url = :url');
      expressionAttributeNames['#url'] = 'url';
      expressionAttributeValues[':url'] = updates.url;
    }

    if (updates.events !== undefined) {
      const eventsValidation = validateEvents(updates.events);
      if (!eventsValidation.isValid) {
        return BadRequest.INVALID_PARAMETER('events', eventsValidation.error);
      }
      updateExpressions.push('events = :events');
      expressionAttributeValues[':events'] = updates.events;
    }

    if (updates.is_active !== undefined) {
      updateExpressions.push('is_active = :is_active');
      expressionAttributeValues[':is_active'] = String(updates.is_active); // Store as string for GSI
    }

    if (updateExpressions.length === 0) {
      // No updates provided, return current webhook
      const { user_id, ...responseWebhook } = webhook;
      return {
        ...responseWebhook,
        is_active: webhook.is_active === 'true' || webhook.is_active === true,
      };
    }

    updateExpressions.push('updated_at = :updated_at');
    expressionAttributeValues[':updated_at'] = new Date().toISOString();

    const updateExpression = 'SET ' + updateExpressions.join(', ');

    const updatedWebhook = await updateItem(
      WEBHOOKS_TABLE,
      { webhook_id: webhookId },
      updateExpression,
      expressionAttributeValues,
      Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined
    );

    logger.info('Webhook updated', {
      webhookId,
      updates: Object.keys(updates),
    });

    // Convert is_active back to boolean for response
    const { user_id, ...responseWebhook } = updatedWebhook;
    return {
      ...responseWebhook,
      is_active: updatedWebhook.is_active === 'true' || updatedWebhook.is_active === true,
    };
  } catch (error) {
    logger.error('Error updating webhook', {
      error: error.message,
      webhookId,
      userSub,
    });
    throw error;
  }
}

/**
 * Delete a webhook
 * @param {string} webhookId - Webhook ID
 * @param {string} userSub - Cognito user sub
 * @returns {Promise<void>}
 */
async function deleteWebhook(webhookId, userSub) {
  try {
    const { webhook, error } = await verifyWebhookOwnership(webhookId, userSub);
    if (error) {
      throw error;
    }

    await deleteItem(WEBHOOKS_TABLE, { webhook_id: webhookId });

    logger.info('Webhook deleted', {
      webhookId,
      userId: webhook.user_id,
    });
  } catch (error) {
    logger.error('Error deleting webhook', {
      error: error.message,
      webhookId,
      userSub,
    });
    throw error;
  }
}

/**
 * Get active webhooks for a user that subscribe to a specific event
 * @param {string} userId - User ID
 * @param {string} eventType - Event type to filter by
 * @returns {Promise<array>} Array of webhook objects
 */
async function getActiveWebhooksForEvent(userId, eventType) {
  try {
    // Query active webhooks for user
    const result = await query(
      WEBHOOKS_TABLE,
      'user_id = :user_id AND is_active = :is_active',
      {
        ':user_id': userId,
        ':is_active': 'true', // GSI requires string
      },
      'UserIdStatusIndex'
    );

    const webhooks = result.Items || [];

    // Filter by event type subscription
    const subscribedWebhooks = webhooks
      .filter(wh => {
        return wh.events && Array.isArray(wh.events) && wh.events.includes(eventType);
      })
      .map(wh => ({
        ...wh,
        is_active: wh.is_active === 'true' || wh.is_active === true,
      }));

    return subscribedWebhooks;
  } catch (error) {
    logger.error('Error getting active webhooks for event', {
      error: error.message,
      userId,
      eventType,
    });
    return [];
  }
}

module.exports = {
  createWebhook,
  getWebhook,
  verifyWebhookOwnership,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  getActiveWebhooksForEvent,
  checkWebhookLimit,
  getWebhookLimit,
  VALID_EVENT_TYPES,
  DEFAULT_EVENTS,
};

