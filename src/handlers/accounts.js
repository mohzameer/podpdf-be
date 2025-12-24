/**
 * Accounts handler
 * Handles: POST /accounts, GET /accounts/me, DELETE /accounts/me, PUT /accounts/me/webhook
 */

const logger = require('../utils/logger');
const { Unauthorized, Forbidden, InternalServerError, BadRequest } = require('../utils/errors');
const { extractUserSub } = require('../middleware/auth');
const { getUserAccount, validateUserAndPlan } = require('../services/business');
const { generateULID } = require('../utils/ulid');
const { putItem, updateItem, deleteItem } = require('../services/dynamodb');
const { validateWebhookUrl } = require('../services/validation');
const { CognitoIdentityProviderClient, SignUpCommand, GetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');

const USERS_TABLE = process.env.USERS_TABLE;
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'eu-central-1' });

/**
 * Main handler - routes to appropriate function based on HTTP method and path
 */
async function handler(event) {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod;
    const path = event.requestContext?.http?.path || event.path;

    logger.info('Accounts handler invoked', { method, path });

    if (method === 'POST' && path === '/accounts') {
      return await createAccount(event);
    } else if (method === 'GET' && path === '/accounts/me') {
      return await getAccount(event);
    } else if (method === 'DELETE' && path === '/accounts/me') {
      return await deleteAccount(event);
    } else if (method === 'PUT' && path === '/accounts/me/webhook') {
      return await updateWebhook(event);
    }

    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };
  } catch (error) {
    logger.error('Accounts handler error', { error: error.message, stack: error.stack });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * Get user email from Cognito
 */
async function getUserEmailFromCognito(userSub) {
  try {
    // Note: In a real implementation, you might want to cache this or get it from JWT claims
    // For now, we'll try to get it from Cognito
    // However, the email might already be in the JWT claims
    // This is a placeholder - you may want to extract email from JWT instead
    return null; // Will be set from JWT or user input
  } catch (error) {
    logger.warn('Could not get user email from Cognito', { error: error.message });
    return null;
  }
}

/**
 * POST /accounts - Signup endpoint (creates Cognito user and DynamoDB record)
 */
async function createAccount(event) {
  try {
    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return BadRequest.MISSING_INPUT_TYPE(); // Reuse error format
    }

    const { email, password, name, plan_id } = body;

    // Validate required fields
    if (!email || typeof email !== 'string' || !email.trim()) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'MISSING_EMAIL',
            message: 'email field is required',
          },
        }),
      };
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'INVALID_PASSWORD',
            message: 'password field is required and must be at least 8 characters',
          },
        }),
      };
    }

    // Build user attributes for Cognito
    const userAttributes = [
      {
        Name: 'email',
        Value: email,
      },
    ];

    // Add name if provided
    if (name && typeof name === 'string' && name.trim()) {
      userAttributes.push({
        Name: 'name',
        Value: name.trim(),
      });
    }

    // Sign up user in Cognito
    let cognitoUserSub;
    try {
      const signUpCommand = new SignUpCommand({
        ClientId: COGNITO_CLIENT_ID,
        Username: email,
        Password: password,
        UserAttributes: userAttributes,
      });

      const signUpResponse = await cognitoClient.send(signUpCommand);
      cognitoUserSub = signUpResponse.UserSub;

      logger.info('Cognito user created', { userSub: cognitoUserSub, email });
    } catch (cognitoError) {
      logger.error('Cognito signup error', { error: cognitoError.message, email });

      // Handle Cognito errors
      if (cognitoError.name === 'UsernameExistsException') {
        return {
          statusCode: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: {
              code: 'ACCOUNT_ALREADY_EXISTS',
              message: 'An account with this email already exists',
            },
          }),
        };
      }

      return InternalServerError.GENERIC(`Failed to create Cognito user: ${cognitoError.message}`);
    }

    // Check if DynamoDB record already exists (shouldn't happen, but safety check)
    const existingUser = await getUserAccount(cognitoUserSub);
    if (existingUser) {
      logger.warn('DynamoDB record already exists for new Cognito user', {
        userSub: cognitoUserSub,
        email,
      });
      // Continue anyway - might be a race condition
    }

    // Generate user ID (ULID)
    const userId = generateULID();

    // Create user record in DynamoDB
    const now = new Date().toISOString();
    const userRecord = {
      user_id: userId,
      user_sub: cognitoUserSub,
      email: email,
      display_name: name && typeof name === 'string' && name.trim() ? name.trim() : null,
      plan_id: plan_id || 'free-basic',
      account_status: 'free',
      total_pdf_count: 0,
      created_at: now,
    };

    await putItem(USERS_TABLE, userRecord);

    logger.info('Account created', { userId, userSub: cognitoUserSub, email });

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        email: userRecord.email,
        display_name: userRecord.display_name,
        plan_id: userRecord.plan_id,
        account_status: userRecord.account_status,
        created_at: userRecord.created_at,
        message: 'Account created successfully. Please check your email to verify your account, then sign in to get your JWT token.',
      }),
    };
  } catch (error) {
    logger.error('Error creating account', { error: error.message, stack: error.stack });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * GET /accounts/me - Get account info
 */
async function getAccount(event) {
  try {
    const userSub = await extractUserSub(event);
    if (!userSub) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid JWT token',
          },
        }),
      };
    }

    const user = await getUserAccount(userSub);
    if (!user) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Return user info (excluding sensitive data)
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: user.user_id,
        email: user.email,
        display_name: user.display_name || null,
        plan_id: user.plan_id,
        account_status: user.account_status,
        total_pdf_count: user.total_pdf_count || 0,
        webhook_url: user.webhook_url || null,
        created_at: user.created_at,
        upgraded_at: user.upgraded_at || null,
      }),
    };
  } catch (error) {
    logger.error('Error getting account', { error: error.message });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * DELETE /accounts/me - Delete account
 */
async function deleteAccount(event) {
  try {
    const userSub = await extractUserSub(event);
    if (!userSub) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid JWT token',
          },
        }),
      };
    }

    const user = await getUserAccount(userSub);
    if (!user) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Delete user record
    await deleteItem(USERS_TABLE, { user_id: user.user_id });

    logger.info('Account deleted', { userId: user.user_id, userSub });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Account deleted successfully',
      }),
    };
  } catch (error) {
    logger.error('Error deleting account', { error: error.message });
    return InternalServerError.GENERIC(error.message);
  }
}

/**
 * PUT /accounts/me/webhook - Update webhook URL
 */
async function updateWebhook(event) {
  try {
    const userSub = await extractUserSub(event);
    if (!userSub) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or invalid JWT token',
          },
        }),
      };
    }

    const user = await getUserAccount(userSub);
    if (!user) {
      return Forbidden.ACCOUNT_NOT_FOUND();
    }

    // Parse request body
    let body;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return BadRequest.INVALID_WEBHOOK_URL();
    }

    const { webhook_url } = body;

    // Validate webhook URL
    if (webhook_url) {
      const validation = validateWebhookUrl(webhook_url);
      if (!validation.isValid) {
        return validation.error;
      }
    }

    // Update user record
    await updateItem(
      USERS_TABLE,
      { user_id: user.user_id },
      'SET webhook_url = :webhook_url, updated_at = :updated_at',
      {
        ':webhook_url': webhook_url || null,
        ':updated_at': new Date().toISOString(),
      }
    );

    logger.info('Webhook URL updated', { userId: user.user_id, webhookUrl: webhook_url });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: user.user_id,
        webhook_url: webhook_url || null,
        updated_at: new Date().toISOString(),
      }),
    };
  } catch (error) {
    logger.error('Error updating webhook', { error: error.message });
    return InternalServerError.GENERIC(error.message);
  }
}

module.exports = { handler };

