/**
 * Webhook Manager Handler
 * Handles webhook CRUD operations and history retrieval
 */

const logger = require('../utils/logger');
const { extractUserSub } = require('../middleware/auth');
const { Unauthorized, Forbidden, InternalServerError, BadRequest } = require('../utils/errors');
const {
  createWebhook,
  getWebhook,
  verifyWebhookOwnership,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
} = require('../services/webhook');
const { getWebhookHistory } = require('../services/webhookDelivery');

/**
 * Main handler - routes to appropriate function based on HTTP method and path
 */
async function handler(event) {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.requestContext?.http?.path || event.path;
    const pathParameters = event.pathParameters || {};

    logger.info('Webhook manager handler invoked', { method, path });

    // Extract user sub from JWT
    const userSub = await extractUserSub(event);
    if (!userSub) {
      return Unauthorized.MISSING_TOKEN();
    }

    // Route based on method and path
    if (method === 'POST' && path === '/accounts/me/webhooks') {
      return await createWebhookHandler(event, userSub);
    } else if (method === 'GET' && path === '/accounts/me/webhooks') {
      return await listWebhooksHandler(event, userSub);
    } else if (method === 'GET' && path.startsWith('/accounts/me/webhooks/') && pathParameters.webhook_id) {
      if (path.endsWith('/history')) {
        return await getWebhookHistoryHandler(event, userSub, pathParameters.webhook_id);
      } else {
        return await getWebhookHandler(event, userSub, pathParameters.webhook_id);
      }
    } else if (method === 'PUT' && path.startsWith('/accounts/me/webhooks/') && pathParameters.webhook_id) {
      return await updateWebhookHandler(event, userSub, pathParameters.webhook_id);
    } else if (method === 'DELETE' && path.startsWith('/accounts/me/webhooks/') && pathParameters.webhook_id) {
      return await deleteWebhookHandler(event, userSub, pathParameters.webhook_id);
    }

    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    logger.error('Webhook manager handler error', {
      error: error.message,
      stack: error.stack,
    });
    
    // Check if error is already a formatted response
    if (error.statusCode && error.headers && error.body) {
      return error;
    }
    
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * POST /accounts/me/webhooks - Create a new webhook
 */
async function createWebhookHandler(event, userSub) {
  try {
    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return BadRequest.INVALID_PARAMETER('body', 'Request body must be valid JSON');
    }

    const { name, url, events, is_active } = body;

    // Validate required fields
    if (!url || typeof url !== 'string') {
      return BadRequest.INVALID_WEBHOOK_URL();
    }

    // Create webhook
    try {
      const webhook = await createWebhook(userSub, {
        name,
        url,
        events,
        is_active,
      });

      return {
        statusCode: 201,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhook),
      };
    } catch (error) {
      // Check if error is already a formatted response
      if (error.statusCode && error.headers && error.body) {
        return error;
      }
      throw error;
    }
  } catch (error) {
    logger.error('Error creating webhook', {
      error: error.message,
      userSub,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * GET /accounts/me/webhooks - List webhooks
 */
async function listWebhooksHandler(event, userSub) {
  try {
    const queryParams = event.queryStringParameters || {};
    
    const filters = {
      is_active: queryParams.is_active !== undefined ? queryParams.is_active === 'true' : undefined,
      event: queryParams.event,
      limit: queryParams.limit ? parseInt(queryParams.limit, 10) : undefined,
      next_token: queryParams.next_token,
    };

    const result = await listWebhooks(userSub, filters);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (error) {
    logger.error('Error listing webhooks', {
      error: error.message,
      userSub,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * GET /accounts/me/webhooks/{webhook_id} - Get webhook details
 */
async function getWebhookHandler(event, userSub, webhookId) {
  try {
    const { webhook, error } = await verifyWebhookOwnership(webhookId, userSub);
    
    if (error) {
      return error;
    }

    // Remove user_id from response
    const { user_id, ...responseWebhook } = webhook;
    
    // Convert is_active back to boolean
    responseWebhook.is_active = webhook.is_active === 'true' || webhook.is_active === true;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook: responseWebhook }),
    };
  } catch (error) {
    logger.error('Error getting webhook', {
      error: error.message,
      webhookId,
      userSub,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * PUT /accounts/me/webhooks/{webhook_id} - Update webhook
 */
async function updateWebhookHandler(event, userSub, webhookId) {
  try {
    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return BadRequest.INVALID_PARAMETER('body', 'Request body must be valid JSON');
    }

    const { name, url, events, is_active } = body;

    try {
      const webhook = await updateWebhook(webhookId, userSub, {
        name,
        url,
        events,
        is_active,
      });

      // Check if error response
      if (webhook.statusCode) {
        return webhook;
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhook),
      };
    } catch (error) {
      // Check if error is already a formatted response
      if (error.statusCode && error.headers && error.body) {
        return error;
      }
      throw error;
    }
  } catch (error) {
    logger.error('Error updating webhook', {
      error: error.message,
      webhookId,
      userSub,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * DELETE /accounts/me/webhooks/{webhook_id} - Delete webhook
 */
async function deleteWebhookHandler(event, userSub, webhookId) {
  try {
    await deleteWebhook(webhookId, userSub);

    return {
      statusCode: 204,
      headers: { 'Content-Type': 'application/json' },
      body: '',
    };
  } catch (error) {
    // Check if error is already a formatted response
    if (error.statusCode && error.headers && error.body) {
      return error;
    }
    
    logger.error('Error deleting webhook', {
      error: error.message,
      webhookId,
      userSub,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * GET /accounts/me/webhooks/{webhook_id}/history - Get webhook history
 */
async function getWebhookHistoryHandler(event, userSub, webhookId) {
  try {
    // Verify ownership first
    const { webhook, error } = await verifyWebhookOwnership(webhookId, userSub);
    
    if (error) {
      return error;
    }

    const queryParams = event.queryStringParameters || {};
    
    const filters = {
      status: queryParams.status,
      event_type: queryParams.event_type,
      limit: queryParams.limit ? parseInt(queryParams.limit, 10) : undefined,
      next_token: queryParams.next_token,
    };

    const result = await getWebhookHistory(webhookId, filters);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (error) {
    logger.error('Error getting webhook history', {
      error: error.message,
      webhookId,
      userSub,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

module.exports = { handler };

