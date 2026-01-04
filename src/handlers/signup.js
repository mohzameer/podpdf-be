/**
 * Sign-up handler
 * POST /signup - Create a new Cognito user
 * 
 * After signup, user will receive a verification code via email.
 * Once they confirm with the code, the Post Confirmation trigger
 * will automatically create the DynamoDB account record.
 */

const logger = require('../utils/logger');
const { BadRequest, InternalServerError } = require('../utils/errors');
const {
  CognitoIdentityProviderClient,
  SignUpCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const COGNITO_USER_POOL_CLIENT_ID = process.env.COGNITO_USER_POOL_CLIENT_ID;
const cognitoClient = new CognitoIdentityProviderClient({});

/**
 * Sign-up handler
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

    const { email, password, name } = body;

    // Validate input
    if (!email || !password) {
      return BadRequest.INVALID_PARAMETER('email/password', 'Missing required fields');
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
      return BadRequest.INVALID_PARAMETER('email/password', 'email and password must be strings');
    }

    // Validate email format (basic check)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return BadRequest.INVALID_PARAMETER('email', 'Invalid email format');
    }

    // Validate password meets Cognito requirements
    if (password.length < 8) {
      return BadRequest.INVALID_PARAMETER('password', 'Password must be at least 8 characters long');
    }

    logger.info('Sign-up attempt', { email });

    // Build user attributes
    const userAttributes = [
      {
        Name: 'email',
        Value: email,
      },
    ];

    if (name && typeof name === 'string' && name.trim()) {
      userAttributes.push({
        Name: 'name',
        Value: name.trim(),
      });
    }

    // Sign up user with Cognito
    try {
      const command = new SignUpCommand({
        ClientId: COGNITO_USER_POOL_CLIENT_ID,
        Username: email,
        Password: password,
        UserAttributes: userAttributes,
      });

      const response = await cognitoClient.send(command);

      logger.info('Sign-up successful', { 
        email,
        userSub: response.UserSub,
      });

      return {
        statusCode: 201,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'User created successfully. Please check your email for verification code.',
          userSub: response.UserSub,
          email: email,
          requiresConfirmation: true,
        }),
      };
    } catch (error) {
      logger.error('Cognito sign-up error', {
        error: error.message,
        code: error.name,
        email,
      });

      // Handle specific Cognito errors
      if (error.name === 'UsernameExistsException') {
        return BadRequest.INVALID_PARAMETER('email', 'An account with this email already exists');
      } else if (error.name === 'InvalidPasswordException') {
        return BadRequest.INVALID_PARAMETER('password', 'Password does not meet requirements. Password must be at least 8 characters and contain uppercase, lowercase, numbers, and symbols.');
      } else if (error.name === 'InvalidParameterException') {
        return BadRequest.INVALID_PARAMETER('parameter', `Invalid parameter: ${error.message}`);
      } else if (error.name === 'TooManyRequestsException') {
        return {
          statusCode: 429,
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            error: 'TooManyRequests',
            message: 'Too many sign-up attempts. Please try again later.',
          }),
        };
      }

      // Generic error
      return InternalServerError.GENERIC('Sign-up failed. Please try again later.');
    }
  } catch (error) {
    logger.error('Unexpected error in sign-up handler', {
      error: error.message,
      stack: error.stack,
    });
    return InternalServerError.GENERIC('An unexpected error occurred');
  }
}

module.exports = { handler };

