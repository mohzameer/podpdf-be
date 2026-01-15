/**
 * Paddle Webhook Handler
 * Receives and processes webhook events from Paddle payment gateway
 */

const logger = require('../utils/logger');
const { Unauthorized, BadRequest, InternalServerError } = require('../utils/errors');
const {
  verifyWebhookSignature,
  grantCreditsFromPaddleTransaction,
  handleAdjustment,
} = require('../services/paddle');

/**
 * Main handler for Paddle webhook events
 */
async function handler(event) {
  try {
    // Extract signature from headers
    const signature = event.headers?.['paddle-signature'] || 
                     event.headers?.['Paddle-Signature'] ||
                     event.headers?.['paddle-signature'.toLowerCase()];

    if (!signature) {
      logger.warn('Paddle webhook missing signature header');
      return Unauthorized.MISSING_TOKEN();
    }

    // Get raw body (API Gateway v2 format)
    // IMPORTANT: Must use raw body string for signature verification (do not parse before verification)
    let body = event.body || '';
    
    // Handle base64 encoding if present (API Gateway v2 may base64-encode binary content)
    if (event.isBase64Encoded) {
      body = Buffer.from(body, 'base64').toString('utf8');
    }
    
    // Ensure body is a string
    if (typeof body !== 'string') {
      body = JSON.stringify(body);
    }
    
    if (!body) {
      logger.warn('Paddle webhook missing body');
      return BadRequest.INVALID_PARAMETER('body', 'Request body is required');
    }

    // Verify signature using Paddle SDK
    // The SDK handles all signature verification internally and returns the verified payload
    const verifiedPayload = await verifyWebhookSignature(signature, body);
    if (!verifiedPayload) {
      logger.warn('Paddle webhook signature validation failed', {
        signatureLength: signature.length,
      });
      return Unauthorized.INVALID_TOKEN();
    }

    // Use the verified payload from the SDK (already parsed and verified)
    // Note: SDK returns camelCase keys (eventType, eventId, occurredAt, etc.)
    const payload = verifiedPayload;

    const eventType = payload.eventType; // SDK uses camelCase
    logger.info('Paddle webhook received', {
      eventType: eventType,
      eventId: payload.eventId,
      occurredAt: payload.occurredAt,
      payloadKeys: Object.keys(payload),
      dataKeys: payload.data ? Object.keys(payload.data) : null,
    });

    // Handle transaction.completed or transaction.updated with status=completed
    if (eventType === 'transaction.completed' || 
        (eventType === 'transaction.updated' && payload.data?.status === 'completed')) {
      logger.info('Handling transaction completed event', { eventType, status: payload.data?.status });
      return await handleTransactionCompleted(payload);
    }

    // Handle adjustment events (refunds)
    if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') {
      logger.info('Handling adjustment event', { eventType });
      return await handleAdjustmentEvent(payload);
    }

    // For other event types, log and return success (Paddle expects 200)
    logger.info('Paddle webhook event type not handled', {
      eventType: eventType,
      eventId: payload.eventId,
      fullPayload: JSON.stringify(payload).substring(0, 500), // First 500 chars for debugging
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'processed',
        event_type: eventType,
        message: 'Event received but not processed',
      }),
    };
  } catch (error) {
    logger.error('Paddle webhook handler error', {
      error: error.message,
      stack: error.stack,
    });
    // Return 200 to prevent Paddle retries on unexpected errors
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Internal error processing webhook',
      }),
    };
  }
}

/**
 * Handle transaction.completed event
 * Note: SDK returns camelCase structure (data.id, data.customerId, etc.)
 */
async function handleTransactionCompleted(payload) {
  try {
    const data = payload.data;
    if (!data) {
      logger.warn('Paddle transaction.completed event missing data', {
        eventId: payload.eventId,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'error',
          message: 'Missing transaction data',
        }),
      };
    }

    const transactionId = data.id;
    const items = data.items;
    // Extract userId from customData (passed when creating transaction)
    const userId = data.customData?.userId;

    if (!transactionId) {
      logger.warn('Paddle transaction.completed event missing transaction ID', {
        eventId: payload.eventId,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'error',
          message: 'Missing transaction ID',
        }),
      };
    }

    if (!userId) {
      logger.warn('Paddle transaction.completed event missing userId in customData', {
        eventId: payload.eventId,
        transactionId,
        customData: data.customData ? JSON.stringify(data.customData) : null,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'error',
          message: 'Missing userId in customData',
        }),
      };
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      logger.warn('Paddle transaction.completed event missing items', {
        eventId: payload.eventId,
        transactionId,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'error',
          message: 'Missing transaction items',
        }),
      };
    }

    // Get price ID from first item (SDK structure: items[0].price.id)
    const priceId = items[0]?.price?.id || items[0]?.priceId;
    if (!priceId) {
      logger.warn('Paddle transaction.completed event missing price ID', {
        eventId: payload.eventId,
        transactionId,
        firstItem: items[0] ? JSON.stringify(items[0]).substring(0, 200) : null,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'error',
          message: 'Missing price ID',
        }),
      };
    }

    logger.info('Processing Paddle transaction', {
      transactionId,
      userId,
      priceId,
    });

    // Grant credits
    const result = await grantCreditsFromPaddleTransaction(
      transactionId,
      userId,
      priceId
    );

    if (result.skipped) {
      logger.info('Paddle transaction skipped (already processed)', {
        transactionId,
        reason: result.reason,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'processed',
          event_type: 'transaction.completed',
          transaction_id: transactionId,
          skipped: true,
          reason: result.reason,
        }),
      };
    }

    if (!result.success) {
      logger.error('Failed to grant credits from Paddle transaction', {
        transactionId,
        reason: result.reason,
        error: result.error,
      });
      // Return 200 to prevent Paddle retries (will retry on next webhook delivery)
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'error',
          event_type: 'transaction.completed',
          transaction_id: transactionId,
          message: 'Failed to process transaction',
        }),
      };
    }

    logger.info('Paddle transaction processed successfully', {
      transactionId,
      transactionRecordId: result.transactionId,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'processed',
        event_type: 'transaction.completed',
        transaction_id: transactionId,
        transaction_record_id: result.transactionId,
      }),
    };
  } catch (error) {
    logger.error('Error handling transaction.completed event', {
      error: error.message,
      stack: error.stack,
      event_id: payload?.event_id,
    });
    // Return 200 to prevent Paddle retries
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Internal error processing transaction',
      }),
    };
  }
}

/**
 * Handle adjustment.created or adjustment.updated event (refunds)
 */
async function handleAdjustmentEvent(payload) {
  try {
    const data = payload.data;
    if (!data) {
      logger.warn('Paddle adjustment event missing data', {
        event_id: payload.event_id,
        event_type: payload.event_type,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'error',
          message: 'Missing adjustment data',
        }),
      };
    }

    const adjustmentId = data.id;
    const transactionId = data.transaction_id;

    if (!adjustmentId) {
      logger.warn('Paddle adjustment event missing adjustment ID', {
        event_id: payload.event_id,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'error',
          message: 'Missing adjustment ID',
        }),
      };
    }

    // Process adjustment (refund handling)
    const result = await handleAdjustment(data);

    if (result.skipped) {
      logger.info('Paddle adjustment skipped', {
        adjustmentId,
        transactionId,
        reason: result.reason,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'processed',
          event_type: payload.event_type,
          adjustment_id: adjustmentId,
          skipped: true,
          reason: result.reason,
        }),
      };
    }

    if (!result.success) {
      logger.error('Failed to process Paddle adjustment', {
        adjustmentId,
        transactionId,
        reason: result.reason,
        error: result.error,
      });
      // Return 200 to prevent Paddle retries
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'error',
          event_type: payload.event_type,
          adjustment_id: adjustmentId,
          message: 'Failed to process adjustment',
        }),
      };
    }

    logger.info('Paddle adjustment processed successfully', {
      adjustmentId,
      transactionId,
      creditsRevoked: result.creditsRevoked,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'processed',
        event_type: payload.event_type,
        adjustment_id: adjustmentId,
        transaction_id: transactionId,
        credits_revoked: result.creditsRevoked || 0,
      }),
    };
  } catch (error) {
    logger.error('Error handling adjustment event', {
      error: error.message,
      stack: error.stack,
      event_id: payload?.event_id,
      event_type: payload?.event_type,
    });
    // Return 200 to prevent Paddle retries
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'error',
        message: 'Internal error processing adjustment',
      }),
    };
  }
}

module.exports = { handler };

