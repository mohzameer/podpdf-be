/**
 * Lambda Authorizer for API Gateway HTTP API
 * Validates API keys from x-secure-key header against SSM Parameter Store
 */

const logger = require('../utils/logger');
const { wrapHandler } = require('../utils/sentry');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

// AWS_REGION is automatically provided by Lambda runtime
const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'eu-central-1' });
const SSM_PARAMETER_NAME = process.env.HEALTH_API_KEY_SSM_PARAMETER || '/podpdf/health/api-key';

// Cache the API key to avoid repeated SSM calls
let cachedApiKey = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 5 minutes

/**
 * Get API key from SSM Parameter Store with caching
 * @returns {Promise<string|null>} API key value or null if not found
 */
async function getApiKeyFromSSM() {
  const now = Date.now();
  
  // Return cached value if still valid
  if (cachedApiKey && (now - cacheTimestamp) < CACHE_TTL_MS) {
    logger.debug('Using cached API key from SSM');
    return cachedApiKey;
  }

  try {
    logger.debug('Fetching API key from SSM', { parameterName: SSM_PARAMETER_NAME });
    
    const command = new GetParameterCommand({
      Name: SSM_PARAMETER_NAME,
      WithDecryption: true, // Decrypt SecureString parameters
    });
    
    const response = await ssmClient.send(command);
    
    if (response.Parameter && response.Parameter.Value) {
      cachedApiKey = response.Parameter.Value;
      cacheTimestamp = now;
      logger.debug('API key retrieved from SSM successfully');
      return cachedApiKey;
    }
    
    logger.warn('API key not found in SSM', { parameterName: SSM_PARAMETER_NAME });
    return null;
  } catch (error) {
    logger.error('Error fetching API key from SSM', {
      error: error.message,
      errorName: error.name,
      errorCode: error.code,
      parameterName: SSM_PARAMETER_NAME,
    });
    // Return null on any error - this will cause authorization to fail (401)
    return null;
  }
}

/**
 * Lambda authorizer handler for HTTP API
 * Validates API keys from x-secure-key header against SSM Parameter Store
 * @param {object} event - API Gateway authorizer event (identitySource contains header values)
 * @returns {Promise<object>} Authorizer response
 */
async function handler(event) {
  try {
    logger.debug('API Key Authorizer invoked', {
      identitySource: event.identitySource,
    });

    const key = event.identitySource?.[0]?.trim();
    if (!key) {
      logger.warn('No API key found in request');
      return { isAuthorized: false };
    }

    const expected = (await getApiKeyFromSSM())?.trim();
    if (!expected) {
      logger.error('Failed to retrieve API key from SSM');
      return { isAuthorized: false };
    }

    if (key !== expected) {
      logger.warn('API key validation failed');
      return { isAuthorized: false };
    }

    logger.debug('API key validated successfully');
    return {
      isAuthorized: true,
      context: { auth: 'secure-key' },
    };
  } catch (error) {
    logger.error('Authorizer error', {
      error: error.message,
      stack: error.stack,
      errorName: error.name,
    });
    return { isAuthorized: false };
  }
}

module.exports = { handler: wrapHandler(handler) };

