/**
 * Sign-in handler
 * POST /signin - Authenticate user with Cognito and return tokens
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
 * Sign-in handler
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
      return BadRequest('Invalid JSON in request body');
    }

    const { email, password } = body;

    // Validate input
    if (!email || !password) {
      return BadRequest('Missing required fields: email and password');
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
      return BadRequest('email and password must be strings');
    }

    logger.info('Sign-in attempt', { email });

    // Initiate authentication with Cognito
    try {
      const command = new InitiateAuthCommand({
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: COGNITO_USER_POOL_CLIENT_ID,
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
        },
      });

      const response = await cognitoClient.send(command);

      // Check if authentication was successful
      if (response.AuthenticationResult) {
        const { IdToken, AccessToken, RefreshToken, ExpiresIn } = response.AuthenticationResult;

        logger.info('Sign-in successful', { email });

        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: 'Sign-in successful',
            tokens: {
              idToken: IdToken,
              accessToken: AccessToken,
              refreshToken: RefreshToken,
              expiresIn: ExpiresIn,
            },
          }),
        };
      } else {
        logger.warn('Sign-in failed: No authentication result', { email });
        return Unauthorized('Invalid email or password');
      }
    } catch (error) {
      logger.error('Cognito authentication error', {
        error: error.message,
        code: error.name,
        email,
      });

      // Handle specific Cognito errors
      if (error.name === 'NotAuthorizedException') {
        return Unauthorized('Invalid email or password');
      } else if (error.name === 'UserNotConfirmedException') {
        return BadRequest('User account is not confirmed. Please verify your email address.');
      } else if (error.name === 'UserNotFoundException') {
        return Unauthorized('Invalid email or password');
      } else if (error.name === 'TooManyRequestsException') {
        return {
          statusCode: 429,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            error: 'TooManyRequests',
            message: 'Too many sign-in attempts. Please try again later.',
          }),
        };
      }

      // Generic error
      return InternalServerError('Authentication failed. Please try again later.');
    }
  } catch (error) {
    logger.error('Unexpected error in sign-in handler', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError('An unexpected error occurred');
  }
}

module.exports = { handler };

