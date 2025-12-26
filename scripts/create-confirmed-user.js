#!/usr/bin/env node

/**
 * Script to create confirmed user accounts (bypasses email verification)
 * 
 * Usage:
 *   npm run create-user
 * 
 * Configure users in the USERS array below
 */

const { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminSetUserPasswordCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { ulid } = require('ulid');

// Configuration - replace these with real values for your environment
const COGNITO_USER_POOL_ID = 'eu-central-1_pPRsXjD2S';
const USERS_TABLE = 'podpdf-dev-users';
const AWS_REGION = 'eu-central-1';

// Array of users to create
const USERS = [
  {
    email: 'zamtest@test.com',
    password: 'Intel@123',
    name: 'User Zam',
  },
  // Add more users here as needed
];

// Create a single user account
async function createUser(user, userPoolId, usersTable, cognitoClient, docClient) {
  const { email, password, name } = user;

  // Validate password meets minimum requirements
  if (!password || password.length < 8) {
    throw new Error(`Password for ${email} must be at least 8 characters`);
  }

  try {
    // Build user attributes
    const userAttributes = [
      {
        Name: 'email',
        Value: email,
      },
      {
        Name: 'email_verified',
        Value: 'true',
      },
    ];

    if (name) {
      userAttributes.push({
        Name: 'name',
        Value: name,
      });
    }

    // Create user in Cognito (confirmed)
    const createUserCommand = new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: userAttributes,
      MessageAction: 'SUPPRESS', // Don't send welcome email
      DesiredDeliveryMediums: [], // No delivery mediums needed since we're suppressing
    });

    const createUserResponse = await cognitoClient.send(createUserCommand);
    const userSub = createUserResponse.User?.Attributes?.find(attr => attr.Name === 'sub')?.Value;

    if (!userSub) {
      throw new Error('Could not get user sub from Cognito response');
    }

    // Set permanent password
    const setPasswordCommand = new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: email,
      Password: password,
      Permanent: true,
    });

    await cognitoClient.send(setPasswordCommand);

    // Check if DynamoDB record already exists
    const existingUsersResult = await docClient.send(new QueryCommand({
      TableName: usersTable,
      IndexName: 'UserSubIndex',
      KeyConditionExpression: 'user_sub = :user_sub',
      ExpressionAttributeValues: {
        ':user_sub': userSub,
      },
    }));
    const existingUsers = existingUsersResult.Items || [];

    if (existingUsers && existingUsers.length > 0) {
      const existingUser = existingUsers[0];
      return {
        success: true,
        skipped: true,
        email,
        user: existingUser,
      };
    }

    // Create DynamoDB record
    const userId = ulid();
    const now = new Date().toISOString();

    const userRecord = {
      user_id: userId,
      user_sub: userSub,
      email: email,
      display_name: name || null,
      plan_id: 'free-basic',
      account_status: 'free',
      total_pdf_count: 0,
      created_at: now,
    };

    await docClient.send(new PutCommand({
      TableName: usersTable,
      Item: userRecord,
    }));

    return {
      success: true,
      skipped: false,
      email,
      user: userRecord,
      userSub,
    };

  } catch (error) {
    if (error.name === 'UsernameExistsException' || error.name === 'AliasExistsException') {
      return {
        success: false,
        skipped: false,
        email,
        error: 'User already exists in Cognito',
      };
    }
    throw error;
  }
}

async function main() {
  // Validate configuration
  if (!COGNITO_USER_POOL_ID) {
    console.error('Error: COGNITO_USER_POOL_ID environment variable is required');
    console.error('Example: COGNITO_USER_POOL_ID=us-east-1_xxxxx npm run create-user');
    process.exit(1);
  }

  if (!USERS_TABLE) {
    console.error('Error: USERS_TABLE environment variable is required');
    console.error('Example: USERS_TABLE=podpdf-dev-users npm run create-user');
    process.exit(1);
  }

  // Validate users array
  if (!USERS || USERS.length === 0) {
    console.error('Error: USERS array is empty. Please add users to create.');
    process.exit(1);
  }

  console.log(`Creating ${USERS.length} confirmed user account(s)...`);
  console.log(`User Pool ID: ${COGNITO_USER_POOL_ID}`);
  console.log(`Users Table: ${USERS_TABLE}`);
  console.log(`Region: ${AWS_REGION}`);
  console.log('');

  const cognitoClient = new CognitoIdentityProviderClient({ region: AWS_REGION });
  const dynamoClient = new DynamoDBClient({ region: AWS_REGION });
  const docClient = DynamoDBDocumentClient.from(dynamoClient);

  const results = [];

  // Create all users
  for (let i = 0; i < USERS.length; i++) {
    const user = USERS[i];
    console.log(`[${i + 1}/${USERS.length}] Processing ${user.email}...`);

    try {
      const result = await createUser(user, COGNITO_USER_POOL_ID, USERS_TABLE, cognitoClient, docClient);
      results.push(result);

      if (result.skipped) {
        console.log(`   ⚠️  User already exists in DynamoDB, skipped`);
      } else if (result.success) {
        console.log(`   ✅ User account created successfully`);
        console.log(`      User ID: ${result.user.user_id}`);
        console.log(`      Display Name: ${result.user.display_name || '(not set)'}`);
      } else {
        console.log(`   ❌ ${result.error}`);
      }
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
      results.push({
        success: false,
        skipped: false,
        email: user.email,
        error: error.message,
      });
    }
    console.log('');
  }

  // Summary
  console.log('='.repeat(60));
  console.log('Summary:');
  console.log(`   Total: ${USERS.length}`);
  console.log(`   Created: ${results.filter(r => r.success && !r.skipped).length}`);
  console.log(`   Skipped (already exists): ${results.filter(r => r.skipped).length}`);
  console.log(`   Failed: ${results.filter(r => !r.success && !r.skipped).length}`);
  console.log('='.repeat(60));

  if (results.some(r => !r.success && !r.skipped)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});

