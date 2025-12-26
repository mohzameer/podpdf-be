/**
 * Cognito Post Confirmation Lambda Trigger
 * Automatically creates DynamoDB user record when a user confirms their account
 * 
 * This trigger is invoked by Cognito after:
 * - User signs up and confirms their email
 * - User is confirmed via AdminConfirmSignUp
 */

const logger = require('../utils/logger');
const { getUserAccount } = require('../services/business');
const { generateULID } = require('../utils/ulid');
const { putItem } = require('../services/dynamodb');

const USERS_TABLE = process.env.USERS_TABLE;

/**
 * Cognito Post Confirmation Lambda handler
 * @param {object} event - Cognito trigger event
 * @returns {object} Event object (must return event for Cognito)
 */
async function handler(event) {
  try {
    const userSub = event.request.userAttributes.sub;
    const email = event.request.userAttributes.email;
    const name = event.request.userAttributes.name || null;

    logger.info('Post Confirmation trigger invoked', {
      userSub,
      email,
      triggerSource: event.triggerSource,
    });

    // Check if account already exists
    const existingUser = await getUserAccount(userSub);
    if (existingUser) {
      logger.info('Account already exists, skipping creation', {
        userSub,
        userId: existingUser.user_id,
      });
      // Return event to allow Cognito flow to continue
      return event;
    }

    // Generate user ID (ULID)
    const userId = generateULID();

    // Create user record in DynamoDB
    const now = new Date().toISOString();
    const userRecord = {
      user_id: userId,
      user_sub: userSub,
      email: email,
      display_name: name,
      plan_id: 'free-basic',
      account_status: 'free',
      total_pdf_count: 0,
      created_at: now,
    };

    await putItem(USERS_TABLE, userRecord);

    logger.info('Account created via Post Confirmation trigger', {
      userId,
      userSub,
      email,
    });

    // Return event to allow Cognito flow to continue
    return event;
  } catch (error) {
    logger.error('Error in Post Confirmation trigger', {
      error: error.message,
      stack: error.stack,
      event: JSON.stringify(event),
    });

    // IMPORTANT: Even on error, we should return the event
    // to prevent blocking the Cognito confirmation flow
    // The error will be logged but won't prevent user confirmation
    return event;
  }
}

module.exports = { handler };

