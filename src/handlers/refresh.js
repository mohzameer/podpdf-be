/**
 * Refresh token handler
 * POST /refresh - Refresh authentication tokens using refresh token
 */

const logger = require('../utils/logger');
const { BadRequest, Unauthorized, InternalServerError } = require('../utils/errors');
const {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const COGNITO_USER_POOL_CLIENT_ID = process.env.COGNITO_USER_POOL_CLIENT_ID;
const cognitoClient = new CognitoIdentityProviderClient({});

/**
 * Refresh token handler
 * @param {object} event - API Gateway event
 * @returns {object} API Gateway response
 */
async function handler(event) {
  try {
    // Parse request body
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (error) {
      logger.warn('Invalid JSON in request body', { error: error.message });
      return BadRequest.INVALID_PARAMETER('body', 'Invalid JSON in request body');
    }

    const { refreshToken } = body;

    // Validate input
    if (!refreshToken) {
      return BadRequest.INVALID_PARAMETER('refreshToken', 'Missing required field');
    }

    if (typeof refreshToken !== 'string') {
      return BadRequest.INVALID_PARAMETER('refreshToken', 'refreshToken must be a string');
    }

    logger.info('Refresh token attempt');

    // Initiate token refresh with Cognito
    try {
      const command = new InitiateAuthCommand({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: COGNITO_USER_POOL_CLIENT_ID,
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
        },
      });

      const response = await cognitoClient.send(command);

      // Check if refresh was successful
      if (response.AuthenticationResult) {
        const { IdToken, AccessToken, ExpiresIn } = response.AuthenticationResult;

        logger.info('Token refresh successful');

        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: 'Token refresh successful',
            tokens: {
              idToken: IdToken,
              accessToken: AccessToken,
              expiresIn: ExpiresIn,
            },
          }),
        };
      } else {
        logger.warn('Token refresh failed: No authentication result');
        return Unauthorized.INVALID_TOKEN();
      }
    } catch (error) {
      logger.error('Cognito token refresh error', {
        error: error.message,
        code: error.name,
      });

      // Handle specific Cognito errors
      if (error.name === 'NotAuthorizedException') {
        return Unauthorized.INVALID_TOKEN();
      } else if (error.name === 'TooManyRequestsException') {
        return {
          statusCode: 429,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            error: 'TooManyRequests',
            message: 'Too many refresh attempts. Please try again later.',
          }),
        };
      }

      // Generic error
      return InternalServerError.GENERIC('Token refresh failed. Please try again later.');
    }
  } catch (error) {
    logger.error('Unexpected error in refresh token handler', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC('An unexpected error occurred');
  }
}

module.exports = { handler };

