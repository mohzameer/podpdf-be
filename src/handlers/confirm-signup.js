/**
 * Confirm signup handler
 * POST /confirm-signup - Confirm user email with verification code
 * 
 * After confirming, the Post Confirmation trigger will automatically
 * create the DynamoDB account record.
 */

const logger = require('../utils/logger');
const { BadRequest, InternalServerError } = require('../utils/errors');
const {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const COGNITO_USER_POOL_CLIENT_ID = process.env.COGNITO_USER_POOL_CLIENT_ID;
const cognitoClient = new CognitoIdentityProviderClient({});

/**
 * Confirm signup handler
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

    const { email, confirmationCode } = body;

    // Validate input
    if (!email || !confirmationCode) {
      return BadRequest('Missing required fields: email and confirmationCode');
    }

    if (typeof email !== 'string' || typeof confirmationCode !== 'string') {
      return BadRequest('email and confirmationCode must be strings');
    }

    // Validate email format (basic check)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return BadRequest('Invalid email format');
    }

    logger.info('Confirm signup attempt', { email });

    // Confirm signup with Cognito
    try {
      const command = new ConfirmSignUpCommand({
        ClientId: COGNITO_USER_POOL_CLIENT_ID,
        Username: email,
        ConfirmationCode: confirmationCode,
      });

      await cognitoClient.send(command);

      logger.info('Signup confirmed successfully', { email });

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'Email confirmed successfully. Your account has been created. You can now sign in.',
          email: email,
        }),
      };
    } catch (error) {
      logger.error('Cognito confirm signup error', {
        error: error.message,
        code: error.name,
        email,
      });

      // Handle specific Cognito errors
      if (error.name === 'CodeMismatchException') {
        return BadRequest('Invalid verification code. Please check your email and try again.');
      } else if (error.name === 'ExpiredCodeException') {
        return BadRequest('Verification code has expired. Please request a new code.');
      } else if (error.name === 'NotAuthorizedException') {
        return BadRequest('User is already confirmed or does not exist.');
      } else if (error.name === 'UserNotFoundException') {
        return BadRequest('User not found. Please sign up first.');
      } else if (error.name === 'TooManyRequestsException') {
        return {
          statusCode: 429,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            error: 'TooManyRequests',
            message: 'Too many confirmation attempts. Please try again later.',
          }),
        };
      }

      // Generic error
      return InternalServerError('Confirmation failed. Please try again later.');
    }
  } catch (error) {
    logger.error('Unexpected error in confirm signup handler', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError('An unexpected error occurred');
  }
}

module.exports = { handler };

