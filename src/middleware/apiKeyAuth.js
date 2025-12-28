/**
 * API Key Authentication middleware
 * Extracts and validates API key from request headers
 */

const logger = require('../utils/logger');
const { getItem } = require('../services/dynamodb');

const API_KEYS_TABLE = process.env.API_KEYS_TABLE;

/**
 * Extract API key from request headers
 * @param {object} event - Lambda event
 * @returns {string|null} API key or null if not found
 */
function extractApiKey(event) {
  const headers = event.headers || {};
  
  // Check X-API-Key header first
  const apiKeyHeader = headers['x-api-key'] || headers['X-API-Key'];
  if (apiKeyHeader) {
    return apiKeyHeader;
  }
  
  // Check Authorization header (Bearer token format)
  const authHeader = headers.authorization || headers.Authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    // If it looks like an API key (starts with pk_), return it
    // Otherwise, assume it's a JWT token and return null
    if (token.startsWith('pk_')) {
      return token;
    }
  }
  
  return null;
}

/**
 * Validate API key and return user information
 * @param {string} apiKey - API key to validate
 * @returns {Promise<{userId: string, userSub: string, apiKeyId: string}|null>} User info or null if invalid
 */
async function validateApiKey(apiKey) {
  try {
    if (!apiKey || !apiKey.trim()) {
      return null;
    }
    
    const apiKeyRecord = await getItem(API_KEYS_TABLE, {
      api_key: apiKey.trim(),
    });
    
    if (!apiKeyRecord) {
      logger.debug('API key not found', { apiKey: apiKey.substring(0, 10) + '...' });
      return null;
    }
    
    if (!apiKeyRecord.is_active) {
      logger.debug('API key is inactive', { apiKey: apiKey.substring(0, 10) + '...' });
      return null;
    }
    
    // Update last_used_at timestamp
    const { updateItem } = require('../services/dynamodb');
    const now = new Date().toISOString();
    try {
      await updateItem(
        API_KEYS_TABLE,
        { api_key: apiKey.trim() },
        'SET last_used_at = :now',
        { ':now': now }
      );
    } catch (error) {
      // Log but don't fail - last_used_at update is not critical
      logger.warn('Failed to update last_used_at for API key', {
        error: error.message,
        apiKey: apiKey.substring(0, 10) + '...',
      });
    }
    
    logger.debug('API key validated', {
      userId: apiKeyRecord.user_id,
      userSub: apiKeyRecord.user_sub,
      apiKeyId: apiKeyRecord.api_key_id,
    });
    
    return {
      userId: apiKeyRecord.user_id,
      userSub: apiKeyRecord.user_sub,
      apiKeyId: apiKeyRecord.api_key_id,
    };
  } catch (error) {
    logger.error('Error validating API key', {
      error: error.message,
      apiKey: apiKey ? apiKey.substring(0, 10) + '...' : 'null',
    });
    return null;
  }
}

/**
 * Extract user information from either JWT token or API key
 * @param {object} event - Lambda event
 * @returns {Promise<{userId: string|null, userSub: string|null, apiKeyId: string|null, authMethod: 'jwt'|'api_key'|null}>}
 */
async function extractUserInfo(event) {
  // Try API key first (if both are present, API key takes precedence)
  const apiKey = extractApiKey(event);
  if (apiKey) {
    const apiKeyInfo = await validateApiKey(apiKey);
    if (apiKeyInfo) {
      logger.debug('API key validated', {
        userId: apiKeyInfo.userId,
        userSub: apiKeyInfo.userSub,
        apiKeyId: apiKeyInfo.apiKeyId,
      });
      return {
        userId: apiKeyInfo.userId,
        userSub: apiKeyInfo.userSub,
        apiKeyId: apiKeyInfo.apiKeyId,
        authMethod: 'api_key',
      };
    }
  }
  
  // Try JWT token
  const { extractUserSub } = require('./auth');
  const userSub = await extractUserSub(event);
  if (userSub) {
    return {
      userId: null, // Will be retrieved from user account lookup
      userSub: userSub,
      apiKeyId: null, // No API key used
      authMethod: 'jwt',
    };
  }
  
  return {
    userId: null,
    userSub: null,
    apiKeyId: null,
    authMethod: null,
  };
}

module.exports = {
  extractApiKey,
  validateApiKey,
  extractUserInfo,
};

