/**
 * Credit Deduction Processor
 * Processes credit deduction messages from SQS FIFO queue
 * Ensures idempotency and prevents double-charging
 */

const logger = require('../utils/logger');
const { getItem, putItem, updateItem, queryItems } = require('../services/dynamodb');

const USERS_TABLE = process.env.USERS_TABLE;
const CREDIT_TRANSACTIONS_TABLE = process.env.CREDIT_TRANSACTIONS_TABLE;

/**
 * Generate ULID for transaction ID
 */
function generateULID() {
  const { generateULID: genULID } = require('../utils/ulid');
  return genULID();
}

/**
 * Process a single SQS message for credit deduction
 * @param {object} record - SQS record
 */
async function processMessage(record) {
  let jobId = null;
  let userId = null;

  try {
    // Parse SQS message body
    const messageBody = JSON.parse(record.body);
    userId = messageBody.user_id;
    const amount = messageBody.amount;
    jobId = messageBody.job_id;
    const timestamp = messageBody.timestamp || Date.now();

    logger.info('Processing credit deduction', {
      jobId,
      userId,
      amount,
      messageId: record.messageId,
    });

    // Step 1: Idempotency check - check if transaction with this job_id already exists
    const existingTransactions = await queryItems(
      CREDIT_TRANSACTIONS_TABLE,
      'job_id = :job_id',
      { ':job_id': jobId },
      'JobIdIndex'
    );

    if (existingTransactions && existingTransactions.length > 0) {
      const existingTx = existingTransactions[0];
      if (existingTx.status === 'completed') {
        logger.info('Transaction already processed, skipping', {
          jobId,
          transactionId: existingTx.transaction_id,
        });
        return { skipped: true, reason: 'already_processed' };
      }
      // If status is 'failed', we can retry
      logger.info('Found failed transaction, retrying', {
        jobId,
        transactionId: existingTx.transaction_id,
        status: existingTx.status,
      });
    }

    // Step 2: Get current user balance
    const user = await getItem(USERS_TABLE, { user_id: userId });
    if (!user) {
      logger.error('User not found for credit deduction', { userId, jobId });
      // Mark transaction as failed
      await putItem(CREDIT_TRANSACTIONS_TABLE, {
        transaction_id: generateULID(),
        user_id: userId,
        amount: -amount,
        job_id: jobId,
        transaction_type: 'deduction',
        status: 'failed',
        created_at: new Date().toISOString(),
        processed_at: new Date().toISOString(),
        error_message: 'User not found',
      });
      return { success: false, error: 'user_not_found' };
    }

    const currentBalance = user.credits_balance || 0;
    const freeCreditsRemaining = user.free_credits_remaining || 0;
    const isFreePlan = amount === 0 || amount <= 0;

    // Step 3: For paid plans, check if sufficient credits (safety check)
    // For free plans (amount = 0), skip credit check
    if (!isFreePlan && freeCreditsRemaining <= 0 && currentBalance < amount) {
      logger.warn('Insufficient credits discovered during deduction', {
        userId,
        jobId,
        currentBalance,
        freeCreditsRemaining,
        requiredAmount: amount,
      });
      // Mark transaction as failed (PDF was already generated, acceptable loss)
      await putItem(CREDIT_TRANSACTIONS_TABLE, {
        transaction_id: generateULID(),
        user_id: userId,
        amount: -amount,
        job_id: jobId,
        transaction_type: 'deduction',
        status: 'failed',
        created_at: new Date().toISOString(),
        processed_at: new Date().toISOString(),
        error_message: 'Insufficient credits',
      });
      return { success: false, error: 'insufficient_credits' };
    }

    // Step 4: Atomically update Users table
    // Priority: free_credits_remaining first, then credits_balance
    // For free plans: only increment total_pdf_count (no credit deduction)
    // For paid plans: consume free credits first, then deduct from credits_balance
    try {
      let updatedUser;
      if (isFreePlan) {
        // Free plan: only increment PDF count, no credit deduction
        updatedUser = await updateItem(
          USERS_TABLE,
          { user_id: userId },
          'SET total_pdf_count = if_not_exists(total_pdf_count, :zero) + :inc',
          {
            ':zero': 0,
            ':inc': 1,
          }
        );
      } else if (freeCreditsRemaining > 0) {
        // Paid plan with free credits remaining: consume free credit first
        // Atomically decrement free_credits_remaining and increment PDF count
        updatedUser = await updateItem(
          USERS_TABLE,
          { user_id: userId },
          'SET free_credits_remaining = free_credits_remaining - :dec, total_pdf_count = if_not_exists(total_pdf_count, :zero) + :inc',
          {
            ':dec': 1,
            ':zero': 0,
            ':inc': 1,
          },
          {},
          'free_credits_remaining > :zero' // Conditional: only decrement if free credits available
        );
      } else {
        // Paid plan, no free credits: deduct from credits_balance
        updatedUser = await updateItem(
          USERS_TABLE,
          { user_id: userId },
          'SET credits_balance = credits_balance - :cost, credits_last_updated_at = :now, total_pdf_count = if_not_exists(total_pdf_count, :zero) + :inc',
          {
            ':cost': amount,
            ':now': new Date().toISOString(),
            ':zero': 0,
            ':inc': 1,
          },
          {},
          'credits_balance >= :cost' // Conditional: only deduct if sufficient
        );
      }

      const newBalance = updatedUser.credits_balance || currentBalance;
      const newFreeCredits = updatedUser.free_credits_remaining ?? freeCreditsRemaining;
      const newPdfCount = updatedUser.total_pdf_count || 0;

      // Step 5: Log transaction to CreditTransactions table
      const transactionId = generateULID();
      // If free credits were consumed, amount is 0 (no prepaid credits deducted)
      const transactionAmount = freeCreditsRemaining > 0 ? 0 : -amount;
      await putItem(CREDIT_TRANSACTIONS_TABLE, {
        transaction_id: transactionId,
        user_id: userId,
        amount: transactionAmount, // 0 if free credits used, -amount if prepaid credits used
        job_id: jobId,
        transaction_type: 'deduction',
        status: 'completed',
        created_at: new Date(timestamp).toISOString(),
        processed_at: new Date().toISOString(),
        used_free_credits: freeCreditsRemaining > 0, // Track if free credits were consumed
      });

      logger.info('PDF count updated (credit deduction processed)', {
        jobId,
        userId,
        amount,
        isFreePlan,
        oldBalance: currentBalance,
        newBalance,
        oldFreeCredits: freeCreditsRemaining,
        newFreeCredits: newFreeCredits,
        newPdfCount,
        transactionId,
      });

      return {
        success: true,
        transactionId,
        oldBalance: currentBalance,
        newBalance,
        newPdfCount,
      };
    } catch (error) {
      // Conditional update failed (insufficient credits or other error)
      logger.error('Failed to process PDF count update', {
        error: error.message,
        userId,
        jobId,
        currentBalance,
        amount,
        isFreePlan,
      });

      // Mark transaction as failed
      await putItem(CREDIT_TRANSACTIONS_TABLE, {
        transaction_id: generateULID(),
        user_id: userId,
        amount: -amount,
        job_id: jobId,
        transaction_type: 'deduction',
        status: 'failed',
        created_at: new Date(timestamp).toISOString(),
        processed_at: new Date().toISOString(),
        error_message: error.message,
      });

      return { success: false, error: error.message };
    }
  } catch (error) {
    logger.error('Error processing credit deduction message', {
      error: error.message,
      jobId,
      userId,
      messageId: record.messageId,
    });
    throw error; // Re-throw to trigger SQS retry
  }
}

/**
 * Lambda handler for SQS FIFO queue
 */
async function handler(event) {
  const results = {
    processed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  for (const record of event.Records) {
    try {
      const result = await processMessage(record);
      if (result.skipped) {
        results.skipped++;
      } else if (result.success) {
        results.processed++;
      } else {
        results.failed++;
        results.errors.push({
          jobId: record.body ? JSON.parse(record.body).job_id : null,
          error: result.error,
        });
      }
    } catch (error) {
      results.failed++;
      results.errors.push({
        messageId: record.messageId,
        error: error.message,
      });
      logger.error('Failed to process credit deduction message', {
        error: error.message,
        messageId: record.messageId,
      });
      // Don't throw - let SQS handle retries via visibility timeout
    }
  }

  logger.info('Credit deduction batch completed', results);

  return {
    statusCode: 200,
    body: JSON.stringify(results),
  };
}

module.exports = { handler };

