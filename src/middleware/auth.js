/**
 * Authentication middleware
 * Extracts user ID (sub) from JWT token validated by API Gateway
 * Note: API Gateway JWT authorizer validates tokens, so we just extract from request context
 */

const logger = require('../utils/logger');

/**
 * Extract user ID (sub) from JWT token
 * API Gateway JWT authorizer validates the token and adds claims to requestContext
 * @param {object} event - Lambda event
 * @returns {string|null} User sub or null if invalid
 */
async function extractUserSub(event) {
  try {
    // API Gateway JWT authorizer adds claims to requestContext.authorizer.jwt.claims
    const claims = event.requestContext?.authorizer?.jwt?.claims;
    if (claims?.sub) {
      logger.debug('Extracted user sub from JWT claims', { userSub: claims.sub });
      return claims.sub;
    }

    // Fallback: check alternative locations
    const sub = event.requestContext?.authorizer?.claims?.sub || 
                 event.requestContext?.authorizer?.sub;
    
    if (sub) {
      logger.debug('Extracted user sub from authorizer', { userSub: sub });
      return sub;
    }

    logger.warn('Could not extract user sub from request context', {
      requestContext: JSON.stringify(event.requestContext),
    });
    return null;
  } catch (error) {
    logger.error('Error extracting user sub', { error: error.message });
    return null;
  }
}

module.exports = {
  extractUserSub,
};
