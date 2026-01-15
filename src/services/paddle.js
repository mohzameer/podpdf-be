/**
 * Paddle Service
 * Handles Paddle webhook signature verification, credit mapping, and user lookup
 */

const { Paddle } = require('@paddle/paddle-node-sdk');
const logger = require('../utils/logger');
const { queryItems, getItem, putItem, updateItem, scan } = require('./dynamodb');
const { purchaseCredits } = require('./business');
const { generateULID } = require('../utils/ulid');

const USERS_TABLE = process.env.USERS_TABLE;
const CREDIT_TRANSACTIONS_TABLE = process.env.CREDIT_TRANSACTIONS_TABLE;
const CREDIT_LEDGER_TABLE = process.env.CREDIT_LEDGER_TABLE;
const REFUND_LOG_TABLE = process.env.REFUND_LOG_TABLE;
const CREDIT_MAPPINGS_TABLE = process.env.CREDIT_MAPPINGS_TABLE;
const PADDLE_WEBHOOK_SECRET_SSM = process.env.PADDLE_WEBHOOK_SECRET_SSM;

// Initialize Paddle SDK instance (API key not needed for webhook verification)
const paddle = new Paddle('');

// Credit mappings are now stored in DynamoDB CreditMappingsTable
// Table structure:
// - PK: price_id (string)
// - Attributes: credits_amount (number), active (boolean), created_at, updated_at


// Cache the webhook secret to avoid repeated SSM calls
let cachedWebhookSecret = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Get Paddle webhook secret from SSM Parameter Store with caching
 * @returns {Promise<string|null>} Webhook secret or null if not found
 */
async function getPaddleWebhookSecret() {
  if (!PADDLE_WEBHOOK_SECRET_SSM) {
    logger.warn('PADDLE_WEBHOOK_SECRET_SSM environment variable not set');
    return null;
  }

  const now = Date.now();
  
  // Return cached value if still valid
  if (cachedWebhookSecret && (now - cacheTimestamp) < CACHE_TTL_MS) {
    logger.debug('Using cached Paddle webhook secret from SSM');
    return cachedWebhookSecret;
  }

  try {
    const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
    const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'eu-central-1' });
    
    logger.debug('Fetching Paddle webhook secret from SSM', { parameterName: PADDLE_WEBHOOK_SECRET_SSM });
    
    const command = new GetParameterCommand({
      Name: PADDLE_WEBHOOK_SECRET_SSM,
      WithDecryption: true, // Webhook secret should be encrypted
    });

    const response = await ssmClient.send(command);
    
    if (response.Parameter && response.Parameter.Value) {
      cachedWebhookSecret = response.Parameter.Value;
      cacheTimestamp = now;
      logger.debug('Paddle webhook secret retrieved from SSM successfully');
      return cachedWebhookSecret;
    }
    
    logger.warn('Paddle webhook secret not found in SSM', { parameterName: PADDLE_WEBHOOK_SECRET_SSM });
    return null;
  } catch (error) {
    logger.error('Error getting Paddle webhook secret from SSM', {
      error: error.message,
      errorName: error.name,
      errorCode: error.code,
      ssmPath: PADDLE_WEBHOOK_SECRET_SSM,
    });
    return null;
  }
}

/**
 * Verify Paddle webhook signature using Paddle SDK
 * Uses Paddle SDK's unmarshal method: unmarshal(body, secretKey, signature)
 * @param {string} signatureHeader - Signature from paddle-signature header
 * @param {string|Buffer} body - Raw request body (must be unparsed string or Buffer)
 * @returns {Promise<object|null>} Verified payload object if valid, null if invalid
 */
async function verifyWebhookSignature(signatureHeader, body) {
  if (!signatureHeader || !body) {
    logger.warn('Missing signature header or body for webhook verification');
    return null;
  }

  try {
    // Get webhook secret from SSM
    const secretKey = await getPaddleWebhookSecret();
    if (!secretKey) {
      logger.error('Paddle webhook secret not found in SSM');
      return null;
    }

    // Convert body to string if it's a Buffer (Paddle SDK expects string)
    const rawRequestBody = typeof body === 'string' ? body : body.toString('utf8');
    
    logger.info('Verifying webhook with Paddle SDK', {
      signatureHeaderLength: signatureHeader.length,
      signatureHeaderPreview: signatureHeader.substring(0, 100),
      bodyLength: rawRequestBody.length,
    });

    // Use Paddle SDK's unmarshal method: unmarshal(body, secretKey, signature)
    // This handles all signature verification internally
    const verifiedPayload = paddle.webhooks.unmarshal(rawRequestBody, secretKey, signatureHeader);
    
    logger.info('Paddle webhook signature verification succeeded');
    return verifiedPayload;
  } catch (error) {
    logger.warn('Paddle webhook signature verification failed', {
      error: error.message,
      errorName: error.name,
      errorStack: error.stack,
    });
    return null;
  }
}

/**
 * Get credit amount for a Paddle price ID from DynamoDB
 * @param {string} priceId - Paddle price ID
 * @returns {Promise<number|null>} Credit amount or null if not found
 */
async function getCreditAmount(priceId) {
  if (!priceId || typeof priceId !== 'string') {
    return null;
  }

  try {
    const mapping = await getItem(CREDIT_MAPPINGS_TABLE, { price_id: priceId });
    
    if (!mapping) {
      logger.warn('Credit mapping not found for price ID', { priceId });
      return null;
    }

    // Check if mapping is active (if active field exists)
    if (mapping.active === false) {
      logger.warn('Credit mapping is inactive for price ID', { priceId });
      return null;
    }

    const creditsAmount = mapping.credits_amount;
    if (typeof creditsAmount !== 'number' || creditsAmount <= 0) {
      logger.warn('Invalid credits_amount in credit mapping', { 
        priceId, 
        creditsAmount,
        mappingType: typeof creditsAmount,
      });
      return null;
    }

    return creditsAmount;
  } catch (error) {
    logger.error('Error getting credit amount from DynamoDB', {
      error: error.message,
      priceId,
    });
    return null;
  }
}

/**
 * Find user by email using EmailIndex GSI
 * @param {string} email - User email address
 * @returns {Promise<object|null>} User record or null
 */
async function findUserByEmail(email) {
  if (!email || typeof email !== 'string') {
    return null;
  }

  try {
    const normalizedEmail = email.toLowerCase().trim();
    const users = await queryItems(
      USERS_TABLE,
      'email = :email',
      { ':email': normalizedEmail },
      'EmailIndex'
    );

    if (users && users.length > 0) {
      return users[0];
    }

    return null;
  } catch (error) {
    logger.error('Error finding user by email', {
      error: error.message,
      email: email.substring(0, 3) + '***', // Mask email in logs
    });
    return null;
  }
}

/**
 * Check if transaction already processed (idempotency check)
 * @param {string} referenceId - Paddle transaction ID
 * @returns {Promise<object|null>} Existing transaction or null
 */
async function checkExistingTransaction(referenceId) {
  if (!referenceId) {
    return null;
  }

  try {
    const transactions = await queryItems(
      CREDIT_TRANSACTIONS_TABLE,
      'reference_id = :ref_id',
      { ':ref_id': referenceId },
      'ReferenceIdIndex'
    );

    if (transactions && transactions.length > 0) {
      return transactions[0];
    }

    return null;
  } catch (error) {
    logger.error('Error checking existing transaction', {
      error: error.message,
      referenceId,
    });
    return null;
  }
}

/**
 * Grant credits from Paddle transaction
 * @param {string} transactionId - Paddle transaction ID
 * @param {string} userId - User ID from customData
 * @param {string} priceId - Paddle price ID
 * @returns {Promise<{success: boolean, skipped: boolean, reason: string|null, transactionId: string|null, error: object|null}>}
 */
async function grantCreditsFromPaddleTransaction(transactionId, userId, priceId) {
  try {
    // Step 1: Idempotency check
    const existingTx = await checkExistingTransaction(transactionId);
    if (existingTx && existingTx.status === 'completed') {
      logger.info('Paddle transaction already processed', {
        transactionId,
        existingTransactionId: existingTx.transaction_id,
        userId,
      });
      return {
        success: true,
        skipped: true,
        reason: 'already_processed',
        transactionId: existingTx.transaction_id,
        error: null,
      };
    }

    // Step 2: Get credit amount from DynamoDB
    const creditAmount = await getCreditAmount(priceId);
    if (!creditAmount) {
      logger.warn('Invalid price ID, no credit mapping found', {
        transactionId,
        priceId,
        userId,
      });
      return {
        success: false,
        skipped: false,
        reason: 'invalid_price_id',
        transactionId: null,
        error: { message: `No credit mapping found for price ID: ${priceId}` },
      };
    }

    // Step 3: Verify user exists
    const user = await getItem(USERS_TABLE, { user_id: userId });
    if (!user) {
      logger.warn('User not found for Paddle transaction', {
        transactionId,
        userId,
        priceId,
      });
      return {
        success: false,
        skipped: false,
        reason: 'user_not_found',
        transactionId: null,
        error: { message: `User not found: ${userId}` },
      };
    }

    // Step 4: Grant credits
    const result = await purchaseCredits(userId, creditAmount, {
      reference_id: transactionId,
      payment_provider: 'paddle',
      price_id: priceId, // Store Paddle price ID for reference
    });

    if (!result.success) {
      logger.error('Failed to grant credits from Paddle transaction', {
        transactionId,
        userId,
        creditAmount,
        error: result.error,
      });
      return {
        success: false,
        skipped: false,
        reason: 'credit_grant_failed',
        transactionId: null,
        error: result.error,
      };
    }

    // Step 5: Create credit ledger entry
    const nowISO = new Date().toISOString();
    const ledgerId = generateULID();
    await putItem(CREDIT_LEDGER_TABLE, {
      ledger_id: ledgerId,
      transaction_id: transactionId,
      user_id: userId,
      price_id: priceId, // Store Paddle price ID for reference
      credits_granted: creditAmount,
      credits_used: 0,
      credits_revoked: 0,
      created_at: nowISO,
      updated_at: nowISO,
    });

    logger.info('Credits granted from Paddle transaction', {
      transactionId,
      userId,
      creditAmount,
      newBalance: result.newBalance,
      transactionRecordId: result.transactionId,
      ledgerId,
      upgraded: result.upgraded,
    });

    return {
      success: true,
      skipped: false,
      reason: null,
      transactionId: result.transactionId,
      ledgerId,
      error: null,
    };
  } catch (error) {
    logger.error('Error granting credits from Paddle transaction', {
      error: error.message,
      stack: error.stack,
      transactionId,
      userEmail: userEmail?.substring(0, 3) + '***',
      priceId,
    });
    return {
      success: false,
      skipped: false,
      reason: 'unexpected_error',
      transactionId: null,
      error: { message: error.message },
    };
  }
}

/**
 * Check if refund already processed (idempotency check)
 * @param {string} adjustmentId - Paddle adjustment ID
 * @returns {Promise<boolean>} True if already processed
 */
async function isRefundProcessed(adjustmentId) {
  if (!adjustmentId) {
    return false;
  }

  try {
    const refundLog = await getItem(REFUND_LOG_TABLE, { adjustment_id: adjustmentId });
    return !!refundLog;
  } catch (error) {
    logger.error('Error checking refund log', {
      error: error.message,
      adjustmentId,
    });
    return false;
  }
}

/**
 * Get credit ledger by transaction ID
 * @param {string} transactionId - Paddle transaction ID
 * @returns {Promise<object|null>} Credit ledger or null
 */
async function getCreditLedger(transactionId) {
  if (!transactionId) {
    return null;
  }

  try {
    return await getItem(CREDIT_LEDGER_TABLE, { transaction_id: transactionId });
  } catch (error) {
    logger.error('Error getting credit ledger', {
      error: error.message,
      transactionId,
    });
    return null;
  }
}

/**
 * Get original transaction amount from Paddle transaction
 * This would typically require calling Paddle API, but for now we'll use the credit ledger
 * @param {string} transactionId - Paddle transaction ID
 * @returns {Promise<number|null>} Transaction amount in USD or null
 */
async function getTransactionAmount(transactionId) {
  // For now, we'll derive from credit ledger
  // In production, you might want to store the original amount in the ledger
  const ledger = await getCreditLedger(transactionId);
  if (!ledger) {
    return null;
  }
  
  // Estimate: 1 credit = $0.01 USD
  // This is approximate - in production, store original_amount in ledger
  return ledger.credits_granted * 0.01;
}

/**
 * Process approved refund
 * @param {object} adjustment - Paddle adjustment data
 * @returns {Promise<{success: boolean, skipped: boolean, reason: string|null, creditsRevoked: number|null}>}
 */
async function processApprovedRefund(adjustment) {
  try {
    const adjustmentId = adjustment.id;
    const transactionId = adjustment.transaction_id;
    const refundAmount = Number(adjustment.totals?.total || 0);

    // Step 1: Idempotency check
    if (await isRefundProcessed(adjustmentId)) {
      logger.info('Refund already processed', {
        adjustmentId,
        transactionId,
      });
      return {
        success: true,
        skipped: true,
        reason: 'already_processed',
        creditsRevoked: null,
      };
    }

    // Step 2: Get credit ledger
    const ledger = await getCreditLedger(transactionId);
    if (!ledger) {
      logger.warn('Credit ledger not found for refund', {
        adjustmentId,
        transactionId,
      });
      // Mark as processed even if ledger not found (to prevent retries)
      await putItem(REFUND_LOG_TABLE, {
        adjustment_id: adjustmentId,
        transaction_id: transactionId,
        refund_amount: refundAmount.toString(),
        credits_revoked: 0,
        processed_at: new Date().toISOString(),
      });
      return {
        success: true,
        skipped: true,
        reason: 'ledger_not_found',
        creditsRevoked: 0,
      };
    }

    // Step 3: Calculate unused credits
    const unusedCredits = ledger.credits_granted - (ledger.credits_used || 0) - (ledger.credits_revoked || 0);
    
    if (unusedCredits <= 0) {
      logger.info('No unused credits to revoke', {
        adjustmentId,
        transactionId,
        creditsGranted: ledger.credits_granted,
        creditsUsed: ledger.credits_used || 0,
        creditsRevoked: ledger.credits_revoked || 0,
      });
      // Mark as processed (no credits to revoke)
      await putItem(REFUND_LOG_TABLE, {
        adjustment_id: adjustmentId,
        transaction_id: transactionId,
        refund_amount: refundAmount.toString(),
        credits_revoked: 0,
        processed_at: new Date().toISOString(),
      });
      return {
        success: true,
        skipped: true,
        reason: 'no_unused_credits',
        creditsRevoked: 0,
      };
    }

    // Step 4: Revoke all unused credits (full refund only)
    const creditsToRevoke = unusedCredits;
    const nowISO = new Date().toISOString();

    // Update user's credit balance
    await updateItem(
      USERS_TABLE,
      { user_id: ledger.user_id },
      'SET credits_balance = credits_balance - :revoke, credits_last_updated_at = :now',
      {
        ':revoke': creditsToRevoke,
        ':now': nowISO,
      }
    );

    // Update credit ledger
    await updateItem(
      CREDIT_LEDGER_TABLE,
      { transaction_id: transactionId },
      'SET credits_revoked = credits_revoked + :revoke, updated_at = :now',
      {
        ':revoke': creditsToRevoke,
        ':now': nowISO,
      }
    );

    // Log refund transaction (negative amount)
    const refundTransactionId = generateULID();
    await putItem(CREDIT_TRANSACTIONS_TABLE, {
      transaction_id: refundTransactionId,
      user_id: ledger.user_id,
      amount: -creditsToRevoke, // Negative for refunds
      transaction_type: 'refund',
      status: 'completed',
      reference_id: adjustmentId,
      payment_provider: 'paddle',
      created_at: nowISO,
      processed_at: nowISO,
    });

    // Mark refund as processed
    await putItem(REFUND_LOG_TABLE, {
      adjustment_id: adjustmentId,
      transaction_id: transactionId,
      refund_amount: refundAmount.toString(),
      credits_revoked: creditsToRevoke,
      processed_at: nowISO,
    });

    logger.info('Refund processed successfully', {
      adjustmentId,
      transactionId,
      userId: ledger.user_id,
      refundAmount,
      creditsRevoked: creditsToRevoke,
      refundTransactionId,
    });

    return {
      success: true,
      skipped: false,
      reason: null,
      creditsRevoked: creditsToRevoke,
    };
  } catch (error) {
    logger.error('Error processing refund', {
      error: error.message,
      stack: error.stack,
      adjustmentId: adjustment?.id,
      transactionId: adjustment?.transaction_id,
    });
    return {
      success: false,
      skipped: false,
      reason: 'unexpected_error',
      creditsRevoked: null,
      error: { message: error.message },
    };
  }
}

/**
 * Handle adjustment event (refunds)
 * @param {object} adjustmentData - Paddle adjustment data
 * @returns {Promise<{success: boolean, skipped: boolean, reason: string|null}>}
 */
async function handleAdjustment(adjustmentData) {
  try {
    // Filter for refund adjustments only
    if (adjustmentData.action !== 'refund') {
      logger.info('Adjustment is not a refund, ignoring', {
        adjustmentId: adjustmentData.id,
        action: adjustmentData.action,
      });
      return {
        success: true,
        skipped: true,
        reason: 'not_a_refund',
      };
    }

    // Only process approved refunds
    if (adjustmentData.status !== 'approved') {
      logger.info('Refund not approved yet, ignoring', {
        adjustmentId: adjustmentData.id,
        status: adjustmentData.status,
      });
      return {
        success: true,
        skipped: true,
        reason: 'not_approved',
      };
    }

    // Process approved refund
    return await processApprovedRefund(adjustmentData);
  } catch (error) {
    logger.error('Error handling adjustment', {
      error: error.message,
      stack: error.stack,
      adjustmentId: adjustmentData?.id,
    });
    return {
      success: false,
      skipped: false,
      reason: 'unexpected_error',
      error: { message: error.message },
    };
  }
}

/**
 * Get all active credit packages from DynamoDB
 * @returns {Promise<Array>} Array of credit packages (price_id, credits_amount, etc.)
 */
async function getAllCreditPackages() {
  try {
    // Scan the CreditMappingsTable to get all items
    // Note: For a small table (credit mappings), scan is acceptable
    // If this grows large, consider adding a GSI with active as partition key
    const items = await scan(CREDIT_MAPPINGS_TABLE);
    
    // Filter for active packages and format
    const packages = (items || [])
      .filter(pkg => pkg.active !== false) // Include if active is true or undefined
      .map(pkg => ({
        price_id: pkg.price_id,
        credits_amount: pkg.credits_amount,
        active: pkg.active !== false,
        created_at: pkg.created_at,
        updated_at: pkg.updated_at,
      }))
      .sort((a, b) => a.credits_amount - b.credits_amount); // Sort by credits amount ascending

    return packages;
  } catch (error) {
    logger.error('Error getting credit packages from DynamoDB', {
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

module.exports = {
  verifyWebhookSignature,
  getPaddleWebhookSecret,
  getCreditAmount,
  getAllCreditPackages,
  findUserByEmail,
  grantCreditsFromPaddleTransaction,
  checkExistingTransaction,
  handleAdjustment,
  processApprovedRefund,
  getCreditLedger,
  isRefundProcessed,
};

