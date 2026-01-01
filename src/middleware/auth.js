/**
 * Authentication middleware
 * Extracts user ID (sub) from JWT token
 * Supports both API Gateway authorizer (claims in requestContext) and direct JWT verification
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const logger = require('../utils/logger');

const REGION = process.env.AWS_REGION || 'eu-central-1';
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.COGNITO_USER_POOL_CLIENT_ID;

// JWKS client for fetching Cognito public keys
let jwksClientInstance = null;

function getJwksClient() {
  if (!jwksClientInstance && USER_POOL_ID) {
    jwksClientInstance = jwksClient({
      jwksUri: `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`,
      cache: true,
      cacheMaxAge: 600000, // 10 minutes
      rateLimit: true,
    });
  }
  return jwksClientInstance;
}

/**
 * Get signing key from JWKS
 */
function getSigningKey(header, callback) {
  const client = getJwksClient();
  if (!client) {
    return callback(new Error('JWKS client not initialized - missing USER_POOL_ID'));
  }
  
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      return callback(err);
    }
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

/**
 * Verify JWT token from Authorization header
 * @param {string} token - JWT token
 * @returns {Promise<object|null>} Decoded token payload or null if invalid
 */
async function verifyJwtToken(token) {
  return new Promise((resolve) => {
    if (!USER_POOL_ID || !CLIENT_ID) {
      logger.warn('Missing Cognito configuration for JWT verification');
      resolve(null);
      return;
    }

    const issuer = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;

    jwt.verify(
      token,
      getSigningKey,
      {
        issuer,
        audience: CLIENT_ID,
        algorithms: ['RS256'],
      },
      (err, decoded) => {
        if (err) {
          logger.debug('JWT verification failed', { error: err.message });
          resolve(null);
          return;
        }

        // Verify token_use is 'id' (not 'access')
        if (decoded.token_use !== 'id') {
          logger.debug('Invalid token_use', { token_use: decoded.token_use });
          resolve(null);
          return;
        }

        resolve(decoded);
      }
    );
  });
}

/**
 * Extract JWT token from Authorization header
 * @param {object} event - Lambda event
 * @returns {string|null} JWT token or null
 */
function extractBearerToken(event) {
  const headers = event.headers || {};
  const authHeader = headers.authorization || headers.Authorization;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    // Only return if it's NOT an API key (API keys start with pk_)
    if (!token.startsWith('pk_')) {
      return token;
    }
  }
  
  return null;
}

/**
 * Extract user ID (sub) from JWT token
 * First checks if API Gateway authorizer populated claims, then falls back to direct JWT verification
 * @param {object} event - Lambda event
 * @returns {Promise<string|null>} User sub or null if invalid
 */
async function extractUserSub(event) {
  try {
    // Option 1: API Gateway JWT authorizer adds claims to requestContext.authorizer.jwt.claims
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (claims?.sub) {
      logger.debug('Extracted user sub from JWT claims (authorizer)', { userSub: claims.sub });
      return claims.sub;
    }

    // Option 2: Check alternative requestContext locations
    const sub = event.requestContext?.authorizer?.claims?.sub || 
                event.requestContext?.authorizer?.sub;
    
    if (sub) {
      logger.debug('Extracted user sub from authorizer', { userSub: sub });
      return sub;
    }

    // Option 3: No authorizer - verify JWT directly from Authorization header
    const token = extractBearerToken(event);
    if (token) {
      logger.debug('Attempting direct JWT verification');
      const decoded = await verifyJwtToken(token);
      if (decoded?.sub) {
        logger.debug('Extracted user sub from direct JWT verification', { userSub: decoded.sub });
        return decoded.sub;
      }
    }

    logger.debug('Could not extract user sub from request');
    return null;
  } catch (error) {
    logger.error('Error extracting user sub', { error: error.message });
    return null;
  }
}

module.exports = {
  extractUserSub,
  verifyJwtToken,
  extractBearerToken,
};
