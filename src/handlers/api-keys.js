/**
 * API Keys handler
 * POST /accounts/me/api-keys - Create a new API key
 * GET /accounts/me/api-keys - List all API keys for the authenticated user
 * DELETE /accounts/me/api-keys/{api_key_id} - Revoke an API key
 * 
 * Note: These endpoints require JWT authentication (not API key) to prevent API key self-revocation loops
 */

const logger = require('../utils/logger');
const { extractUserSub } = require('../middleware/auth');
const { getUserAccount } = require('../services/business');
const { getItem, putItem, queryItems, updateItem } = require('../services/dynamodb');
const { Forbidden, BadRequest, NotFound, InternalServerError } = require('../utils/errors');
const { generateULID } = require('../utils/ulid');
const crypto = require('crypto');

const API_KEYS_TABLE = process.env.API_KEYS_TABLE;

/**
 * API Keys handler
 * @param {object} event - API Gateway event
 * @returns {object} API Gateway response
 */
async function handler(event) {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.requestContext?.http?.path || event.path;
    const pathParameters = event.pathParameters || {};

    logger.info('API Keys handler invoked', { method, path });

    // Extract user sub from JWT (required for API key management)
    const userSub = await extractUserSub(event);
    if (!userSub) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid JWT token. API key management requires JWT authentication.',
          },
        }),
      };
    }

    // Get user account to get user_id
    const user = await getUserAccount(userSub);
    if (!user || !user.user_id) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    const userId = user.user_id;

    if (method === 'POST' && path === '/accounts/me/api-keys') {
      return await createApiKey(event, userId);
    } else if (method === 'GET' && path === '/accounts/me/api-keys') {
      return await listApiKeys(event, userId);
    } else if (method === 'DELETE' && pathParameters.api_key_id) {
      return await revokeApiKey(event, userId, pathParameters.api_key_id);
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
    logger.error('Error in API Keys handler', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * POST /accounts/me/api-keys - Create a new API key
 */
async function createApiKey(event, userId) {
  try {
    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return BadRequest('Invalid JSON in request body');
    }

    const { name } = body || {};

    // Get user account to get user_sub (we already have userId from handler)
    const userSub = await extractUserSub(event);
    const user = await getUserAccount(userSub);
    if (!user || !user.user_sub) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Generate API key ID (ULID) for tracking/referencing
    const apiKeyId = generateULID();

    // Generate API key secret
    // Format: pk_live_<random> or pk_test_<random> based on stage
    const stage = process.env.STAGE || 'dev';
    const prefix = stage === 'prod' ? 'pk_live_' : 'pk_test_';
    const randomBytes = crypto.randomBytes(32).toString('base64url'); // 43 characters
    const apiKey = `${prefix}${randomBytes}`;

    // Create API key record
    const now = new Date().toISOString();
    const apiKeyRecord = {
      api_key: apiKey,
      api_key_id: apiKeyId,
      user_id: userId,
      user_sub: user.user_sub,
      name: name && typeof name === 'string' && name.trim() ? name.trim() : null,
      is_active: true,
      created_at: now,
      last_used_at: null,
      revoked_at: null,
    };

    await putItem(API_KEYS_TABLE, apiKeyRecord);

    logger.info('API key created', {
      userId,
      apiKeyId,
      apiKeyPrefix: apiKey.substring(0, 10) + '...',
      name: apiKeyRecord.name,
    });

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey, // Return full key only on creation
        api_key_id: apiKeyId,
        name: apiKeyRecord.name,
        created_at: apiKeyRecord.created_at,
        message: 'API key created successfully. Store this key securely - it will not be shown again.',
      }),
    };
  } catch (error) {
    logger.error('Error creating API key', {
      error: error.message,
      userId,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * GET /accounts/me/api-keys - List all API keys for the authenticated user
 */
async function listApiKeys(event, userId) {
  try {
    // Query all API keys for this user using GSI
    const apiKeys = await queryItems(
      API_KEYS_TABLE,
      'user_id = :user_id',
      { ':user_id': userId },
      'UserIdIndex'
    );

    // Format response (don't expose full API key, only prefix)
    const formattedKeys = (apiKeys || []).map(key => ({
      api_key_id: key.api_key_id,
      api_key_prefix: key.api_key.substring(0, 12) + '...', // Show first 12 chars
      name: key.name,
      is_active: key.is_active,
      created_at: key.created_at,
      last_used_at: key.last_used_at,
      revoked_at: key.revoked_at,
    }))
    .sort((a, b) => {
      // Sort by created_at descending (newest first)
      if (a.created_at > b.created_at) return -1;
      if (a.created_at < b.created_at) return 1;
      return 0;
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_keys: formattedKeys,
        count: formattedKeys.length,
      }),
    };
  } catch (error) {
    logger.error('Error listing API keys', {
      error: error.message,
      userId,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * DELETE /accounts/me/api-keys/{api_key_id} - Revoke an API key
 */
async function revokeApiKey(event, userId, apiKeyId) {
  try {
    // apiKeyId is the ULID (from path parameter)
    // Look up the API key using the ApiKeyIdIndex GSI
    const apiKeys = await queryItems(
      API_KEYS_TABLE,
      'api_key_id = :api_key_id',
      { ':api_key_id': apiKeyId },
      'ApiKeyIdIndex'
    );

    if (!apiKeys || apiKeys.length === 0) {
      return NotFound('API key not found');
    }

    const apiKeyRecord = apiKeys[0];

    // Verify the API key belongs to the authenticated user
    if (apiKeyRecord.user_id !== userId) {
      return Forbidden('API key does not belong to authenticated user');
    }

    // Revoke the API key (use api_key as the primary key for update)
    const now = new Date().toISOString();
    await updateItem(
      API_KEYS_TABLE,
      { api_key: apiKeyRecord.api_key },
      'SET is_active = :false, revoked_at = :now',
      { ':false': false, ':now': now }
    );

    logger.info('API key revoked', {
      userId,
      apiKeyId,
      apiKeyPrefix: apiKeyRecord.api_key.substring(0, 10) + '...',
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'API key revoked successfully',
        api_key_id: apiKeyId,
        api_key_prefix: apiKeyRecord.api_key.substring(0, 12) + '...',
        revoked_at: now,
      }),
    };
  } catch (error) {
    logger.error('Error revoking API key', {
      error: error.message,
      userId,
      apiKeyId,
    });
    return InternalServerError.GENERIC(error.message);
  }
}

module.exports = { handler };

