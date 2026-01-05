# Paddle Integration Specification (Backend Only)

## Overview

This specification outlines the backend implementation for integrating Paddle payment processing into the PodPDF system. The integration enables users to purchase credits via Paddle's payment gateway, with automatic credit granting through webhook events.

**Key Features:**
- Paddle webhook endpoint for payment events
- Automatic credit granting on successful payment
- Idempotency to prevent double crediting
- SSM Parameter Store for secure credential management
- Integration with existing credit system

---

## Architecture

### Components

1. **Paddle Webhook Handler** (`src/handlers/paddle-webhook.js`)
   - Receives webhook events from Paddle
   - Validates webhook signatures
   - Processes `transaction.completed` events
   - Grants credits to users

2. **Paddle Service** (`src/services/paddle.js`)
   - Webhook signature verification
   - Credit mapping logic (price ID → credit amount)
   - User lookup by email

3. **SSM Parameter Store**
   - Stores Paddle webhook secrets (sandbox and production)
   - Stores credit mapping configuration (optional, can be hardcoded initially)

---

## Environment Variables (SSM Parameters)

All Paddle-related credentials and configuration will be stored in AWS Systems Manager Parameter Store using the following naming convention:

```
/podpdf/{stage}/paddle/webhook-secret
/podpdf/{stage}/paddle/credit-mapping
```

### Required SSM Parameters

#### 1. Webhook Secret
- **Path:** `/podpdf/{stage}/paddle/webhook-secret`
- **Type:** `SecureString`
- **Description:** Paddle webhook signing secret for signature verification
- **Example:** `/podpdf/dev/paddle/webhook-secret` (sandbox) or `/podpdf/prod/paddle/webhook-secret` (production)

#### 2. Credit Mapping (Optional - can be hardcoded initially)
- **Path:** `/podpdf/{stage}/paddle/credit-mapping`
- **Type:** `String` (JSON)
- **Description:** Mapping of Paddle price IDs to credit amounts
- **Format:**
```json
{
  "pri_test_10usd": 1000,
  "pri_test_50usd": 6000,
  "pri_01abc123": 1000,
  "pri_01def456": 6000
}
```

**Note:** For initial implementation, credit mapping can be hardcoded in the service. SSM can be added later for dynamic configuration.

---

## API Endpoints

### POST /webhooks/paddle

Public webhook endpoint for Paddle payment events.

**Authentication:** None (validated via signature)

**Request Headers:**
- `paddle-signature`: HMAC SHA256 signature of the request body

**Request Body:**
Paddle webhook payload (JSON). Key fields:
- `event_type`: Event type (e.g., `transaction.completed`)
- `data`: Event data containing:
  - `id`: Transaction ID
  - `customer`: Customer object with `email`
  - `items`: Array of items with `price_id`

**Response:**
- `200 OK`: Webhook processed successfully
- `401 Unauthorized`: Invalid signature
- `400 Bad Request`: Invalid payload

**Example Request:**
```json
{
  "event_id": "evt_01abc123",
  "event_type": "transaction.completed",
  "occurred_at": "2025-01-15T10:30:00Z",
  "data": {
    "id": "txn_01abc123",
    "customer_id": "ctm_01abc123",
    "customer": {
      "email": "user@example.com"
    },
    "items": [
      {
        "price_id": "pri_test_10usd",
        "quantity": 1
      }
    ],
    "status": "completed",
    "totals": {
      "total": "10.00",
      "currency_code": "USD"
    }
  }
}
```

---

## Implementation Details

### 1. Webhook Handler (`src/handlers/paddle-webhook.js`)

**Responsibilities:**
- Extract and validate Paddle signature
- Parse webhook payload
- Route to appropriate event handler
- Return appropriate HTTP responses

**Signature Verification:**
- Use HMAC SHA256 with webhook secret from SSM
- Compare signature using `crypto.timingSafeEqual()` to prevent timing attacks
- Return 401 if signature is invalid

**Event Processing:**
- Handle `transaction.completed` events
- Ignore other event types (return 200 but log)
- Extract transaction ID, customer email, and price ID
- Call service to grant credits

**Error Handling:**
- Use existing error utilities from `src/utils/errors.js`
- Log all errors with context using `logger` utility
- Return 200 for processing errors (to prevent Paddle retries on transient issues)
- Return 401 only for signature validation failures using `Unauthorized.MISSING_TOKEN()` or custom error
- Return 400 for invalid payload using `BadRequest.INVALID_PARAMETER()`

### 2. Paddle Service (`src/services/paddle.js`)

**Functions:**

#### `verifyWebhookSignature(signature, body, secret)`
- Verifies HMAC SHA256 signature
- Returns boolean

#### `getCreditAmount(priceId)`
- Maps Paddle price ID to credit amount
- Initially hardcoded mapping
- Can be extended to read from SSM later

#### `grantCreditsFromPaddleTransaction(transactionId, userEmail, priceId)`
- Looks up user by email using `scan` with filter
- Gets credit amount for price ID
- Checks idempotency (prevents double crediting)
- Calls `purchaseCredits` from business service with metadata
- Returns result with transaction details

**Idempotency:**
- Check `CreditTransactions` table for existing transaction with `reference_id = transactionId` using `ReferenceIdIndex` GSI
- If exists and status is `completed`, skip (already processed)
- Use `transactionId` as `reference_id` in credit transaction record

### 3. Credit Transaction Enhancement

**Modify `purchaseCredits` function in `business.js`:**
- Add optional third parameter: `metadata` (object)
- If metadata provided, include `reference_id` and `payment_provider` in transaction record
- Function signature: `purchaseCredits(userId, amount, metadata = null)`

**Add to CreditTransactions table:**
- `reference_id` (String, optional): External transaction ID (e.g., Paddle transaction ID)
- `payment_provider` (String, optional): Payment provider identifier (e.g., "paddle")
- Used for idempotency checks and payment source tracking

**Transaction Record Structure:**
```javascript
{
  transaction_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", // ULID
  user_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  amount: 1000, // Positive for purchases
  transaction_type: "purchase",
  status: "completed",
  reference_id: "txn_01abc123", // Paddle transaction ID (optional)
  payment_provider: "paddle", // Track payment source (optional)
  created_at: "2025-01-15T10:30:00.000Z",
  processed_at: "2025-01-15T10:30:00.000Z"
}
```

**Implementation in `business.js`:**
```javascript
// In purchaseCredits function, modify transaction record creation:
await putItem(CREDIT_TRANSACTIONS_TABLE, {
  transaction_id: transactionId,
  user_id: userId,
  amount: amount,
  transaction_type: 'purchase',
  status: 'completed',
  ...(metadata?.reference_id && { reference_id: metadata.reference_id }),
  ...(metadata?.payment_provider && { payment_provider: metadata.payment_provider }),
  created_at: nowISO,
  processed_at: nowISO,
});
```

---

## Credit Mapping

### Initial Hardcoded Mapping

For sandbox and initial production deployment, use hardcoded mapping:

```javascript
const CREDIT_MAP = {
  // Sandbox price IDs
  'pri_test_10usd': 1000,   // $10 = 1000 credits
  'pri_test_50usd': 6000,   // $50 = 6000 credits
  
  // Production price IDs (to be configured)
  // 'pri_01abc123': 1000,
  // 'pri_01def456': 6000,
};
```

**Credit Calculation:**
- 1 credit = $0.01 USD
- $10 purchase = 1000 credits
- $50 purchase = 6000 credits (or custom rate)

**Note:** This mapping can be moved to SSM Parameter Store later for dynamic configuration without code changes.

---

## Idempotency Strategy

### Problem
Paddle may retry webhook delivery. We must ensure credits are granted exactly once per transaction.

### Solution
1. **Transaction ID Check:** Before granting credits, query `CreditTransactions` table for existing transaction with `reference_id = Paddle transaction ID`
2. **Status Check:** If transaction exists and `status = 'completed'`, skip processing
3. **Atomic Operation:** Use DynamoDB conditional writes to prevent race conditions

### Implementation

```javascript
// Check for existing transaction using ReferenceIdIndex GSI
const { queryItems } = require('./dynamodb');
const existingTx = await queryItems(
  CREDIT_TRANSACTIONS_TABLE,
  'reference_id = :ref_id',
  { ':ref_id': paddleTransactionId },
  'ReferenceIdIndex'
);

if (existingTx && existingTx.length > 0 && existingTx[0].status === 'completed') {
  // Already processed, skip
  logger.info('Paddle transaction already processed', {
    transactionId: paddleTransactionId,
    existingTransactionId: existingTx[0].transaction_id
  });
  return { skipped: true, reason: 'already_processed' };
}

// Grant credits with metadata
const result = await purchaseCredits(userId, creditAmount, {
  reference_id: paddleTransactionId,
  payment_provider: 'paddle'
});

if (!result.success) {
  throw new Error(`Failed to grant credits: ${result.error.message}`);
}

return result;
```

**Note:** The `purchaseCredits` function in `business.js` needs to be extended to accept an optional third parameter `metadata` that includes `reference_id` and `payment_provider`. These fields will be added to the `CreditTransactions` record when creating the transaction.

### Required GSI

Add to `CreditTransactions` table:
- **Index Name:** `ReferenceIdIndex`
- **Partition Key:** `reference_id`
- **Purpose:** Fast lookup for idempotency checks

---

## User Lookup

### Challenge
Paddle webhooks provide customer email, but we need `user_id` to grant credits.

### Solution
Add an email-based GSI to the Users table for efficient lookups.

### Recommended Approach: Email-based GSI

**Why GSI instead of Scan?**
- **Scan:** Reads entire table, expensive, slow, doesn't scale
- **GSI:** Direct lookup by email, fast, efficient, scales well
- **Cost:** GSI adds minimal cost (only when queried) vs scan which reads entire table

**Implementation:**

1. **Add EmailIndex GSI to Users table** (in `resources.yml`):
```yaml
UsersTable:
  GlobalSecondaryIndexes:
    - IndexName: UserSubIndex
      KeySchema:
        - AttributeName: user_sub
          KeyType: HASH
      Projection:
        ProjectionType: ALL
    - IndexName: EmailIndex  # NEW
      KeySchema:
        - AttributeName: email
          KeyType: HASH
      Projection:
        ProjectionType: ALL
  AttributeDefinitions:
    - AttributeName: user_id
      AttributeType: S
    - AttributeName: user_sub
      AttributeType: S
    - AttributeName: email  # NEW
      AttributeType: S
```

2. **Query by email using GSI:**
```javascript
async function findUserByEmail(email) {
  const { queryItems } = require('./dynamodb');
  const normalizedEmail = email.toLowerCase().trim();
  const users = await queryItems(
    USERS_TABLE,
    'email = :email',
    { ':email': normalizedEmail },
    'EmailIndex'  // Use GSI
  );
  return users && users.length > 0 ? users[0] : null;
}
```

**Important:** Email normalization
- Emails must be stored in normalized format (lowercase, trimmed) in Users table
- Check existing account creation code to ensure emails are normalized
- Paddle webhook emails should be normalized before querying
- This ensures consistent lookups regardless of email case variations

**Benefits:**
- Fast O(1) lookup by email
- Scales to millions of users
- Cost-effective (only pays for queries, not full table scans)
- Consistent with existing patterns (similar to UserSubIndex)
- Much better than scan which would read entire table on every webhook

---

## Serverless Configuration

### Function Definition

```yaml
paddle-webhook:
  handler: src/handlers/paddle-webhook.handler
  timeout: 10
  memorySize: 512
  events:
    - httpApi:
        path: /webhooks/paddle
        method: post
        authorizer: null  # Public endpoint (validated via signature)
  environment:
    USERS_TABLE: ${self:custom.tableNames.${self:provider.stage}.users}
    CREDIT_TRANSACTIONS_TABLE: ${self:custom.tableNames.${self:provider.stage}.creditTransactions}
    PADDLE_WEBHOOK_SECRET_SSM: /podpdf/${self:provider.stage}/paddle/webhook-secret
    PADDLE_CREDIT_MAPPING_SSM: /podpdf/${self:provider.stage}/paddle/credit-mapping
```

### IAM Permissions

Add to Lambda IAM role:
```yaml
- Effect: Allow
  Action:
    - ssm:GetParameter
    - ssm:GetParameters
  Resource:
    - arn:aws:ssm:${self:provider.region}:*:parameter/podpdf/${self:provider.stage}/paddle/*
```

---

## Database Changes

### Users Table

**Add Global Secondary Index:**
- **Index Name:** `EmailIndex`
- **Partition Key:** `email`
- **Projection:** `ALL`
- **Purpose:** Fast lookup by email for Paddle webhook processing
- **Location:** Add to `resources.yml` in `UsersTable` definition
- **Note:** Email should be normalized (lowercase, trimmed) when stored and queried

**Add to AttributeDefinitions:**
- `email` (String) - Already exists as attribute, needs to be added to AttributeDefinitions for GSI

### CreditTransactions Table

**Add Attribute:**
- `reference_id` (String, optional): External transaction ID (Paddle transaction ID)

**Add Global Secondary Index:**
- **Index Name:** `ReferenceIdIndex`
- **Partition Key:** `reference_id`
- **Projection:** `ALL`
- **Purpose:** Fast lookup for idempotency checks
- **Location:** Add to `resources.yml` in `CreditTransactionsTable` definition

**Add Attribute (Optional):**
- `payment_provider` (String, optional): Payment provider identifier (e.g., "paddle")

### Migration

No migration needed for existing records. New fields are optional and will be added to new transactions only.

### Code Changes Required

**1. Modify `src/services/business.js`:**
- Update `purchaseCredits` function signature to accept optional `metadata` parameter:
  ```javascript
  async function purchaseCredits(userId, amount, metadata = null)
  ```
- Modify transaction record creation to include optional metadata fields:
  ```javascript
  await putItem(CREDIT_TRANSACTIONS_TABLE, {
    transaction_id: transactionId,
    user_id: userId,
    amount: amount,
    transaction_type: 'purchase',
    status: 'completed',
    ...(metadata?.reference_id && { reference_id: metadata.reference_id }),
    ...(metadata?.payment_provider && { payment_provider: metadata.payment_provider }),
    created_at: nowISO,
    processed_at: nowISO,
  });
  ```

**2. Update `resources.yml`:**

**For UsersTable:**
- Add `EmailIndex` GSI:
  ```yaml
  UsersTable:
    GlobalSecondaryIndexes:
      - IndexName: UserSubIndex
        # ... existing index ...
      - IndexName: EmailIndex  # NEW
        KeySchema:
          - AttributeName: email
            KeyType: HASH
        Projection:
          ProjectionType: ALL
    AttributeDefinitions:
      - AttributeName: user_id
        AttributeType: S
      - AttributeName: user_sub
        AttributeType: S
      - AttributeName: email  # NEW - add for GSI
        AttributeType: S
  ```

**For CreditTransactionsTable:**
- Add `ReferenceIdIndex` GSI:
  ```yaml
  CreditTransactionsTable:
    GlobalSecondaryIndexes:
      - IndexName: UserIdIndex
        # ... existing index ...
      - IndexName: JobIdIndex
        # ... existing index ...
      - IndexName: ReferenceIdIndex  # NEW
        KeySchema:
          - AttributeName: reference_id
            KeyType: HASH
        Projection:
          ProjectionType: ALL
    AttributeDefinitions:
      - AttributeName: transaction_id
        AttributeType: S
      - AttributeName: user_id
        AttributeType: S
      - AttributeName: job_id
        AttributeType: S
      - AttributeName: reference_id  # NEW - add for GSI
        AttributeType: S
  ```

---

## Error Handling

### Webhook Signature Validation Failure
- Return `401 Unauthorized`
- Log error with request details (excluding sensitive data)
- Do not process event

### User Not Found
- Log error with email
- Return `200 OK` (to prevent Paddle retries)
- Consider alerting/monitoring for this case

### Invalid Price ID
- Log warning
- Return `200 OK`
- Do not grant credits

### Credit Granting Failure
- Log error with full context
- Return `200 OK` (Paddle will retry)
- Transaction will be retried on next webhook delivery

### Duplicate Transaction (Idempotency)
- Log info message
- Return `200 OK`
- Skip credit granting

---

## Logging

### Required Log Fields

All log entries should include:
- `event_type`: Paddle event type
- `transaction_id`: Paddle transaction ID
- `user_email`: Customer email (masked for privacy)
- `price_id`: Paddle price ID
- `credit_amount`: Credits to be granted
- `user_id`: User ID (if found)

### Log Levels
- **INFO:** Successful credit grants, idempotency skips
- **WARN:** User not found, invalid price ID, missing data
- **ERROR:** Signature validation failures, credit granting failures, unexpected errors

**Logging Pattern:**
Use the existing `logger` utility from `src/utils/logger.js`:
```javascript
const logger = require('../utils/logger');

logger.info('Paddle webhook processed', {
  event_type: payload.event_type,
  transaction_id: payload.data.id,
  user_email: maskedEmail,
  price_id: priceId,
  credit_amount: creditAmount,
  user_id: userId
});
```

---

## Testing Strategy

### Sandbox Testing

1. **Setup:**
   - Configure Paddle Sandbox webhook endpoint
   - Add sandbox webhook secret to SSM
   - Deploy to dev stage

2. **Test Cases:**
   - Valid transaction.completed event → credits granted
   - Duplicate webhook delivery → idempotency check prevents double crediting
   - Invalid signature → 401 response
   - User not found → logged, 200 response
   - Invalid price ID → logged, 200 response

3. **Verification:**
   - Check CloudWatch logs for webhook events
   - Verify credits in Users table
   - Verify transaction in CreditTransactions table
   - Verify idempotency (retry webhook, no double credits)

### Production Testing

1. **Pre-deployment:**
   - Add production webhook secret to SSM
   - Configure production webhook endpoint in Paddle dashboard
   - Test with small transaction first

2. **Monitoring:**
   - Set up CloudWatch alarms for webhook errors
   - Monitor credit transaction volume
   - Track failed user lookups

---

## Security Considerations

### Webhook Secret Management
- Store secrets in SSM Parameter Store as `SecureString`
- Use IAM policies to restrict access
- Rotate secrets periodically
- Use different secrets for sandbox and production

### Signature Validation
- Always validate signatures using `crypto.timingSafeEqual()`
- Never log webhook secrets
- Return generic errors to prevent information leakage

### Data Privacy
- Mask email addresses in logs (e.g., `u***@example.com`)
- Do not log full transaction payloads
- Comply with data retention policies

---

## Deployment Checklist

### Pre-deployment
- [ ] Add Paddle webhook secret to SSM Parameter Store (sandbox)
- [ ] Configure Paddle Sandbox webhook endpoint URL
- [ ] Test webhook signature verification locally
- [ ] Review credit mapping configuration

### Deployment
- [ ] Deploy Lambda function
- [ ] Verify IAM permissions for SSM access
- [ ] Test webhook endpoint with Paddle test event
- [ ] Verify CloudWatch logs

### Post-deployment
- [ ] Test complete purchase flow (frontend → Paddle → webhook → credits)
- [ ] Verify idempotency (retry webhook)
- [ ] Monitor error rates
- [ ] Set up CloudWatch alarms

### Production Deployment
- [ ] Add production webhook secret to SSM
- [ ] Configure production webhook endpoint in Paddle
- [ ] Update credit mapping with production price IDs
- [ ] Test with small transaction
- [ ] Monitor for 24-48 hours before full rollout

---

## Future Enhancements

### Phase 2 (Optional)
1. **Dynamic Credit Mapping:** Move credit mapping to SSM Parameter Store
2. **Paddle Customer ID Mapping:** Store Paddle customer ID → user_id mapping for faster lookups
3. **Refund Handling:** Handle `transaction.refunded` events
4. **Subscription Support:** Handle subscription events (if needed later)
5. **Webhook Retry Logic:** Implement exponential backoff for failed credit grants
6. **Admin Dashboard:** View Paddle transactions and credit grants

**Note:** Email GSI is now included in Phase 1 implementation (not optional) for efficient user lookups.

---

## API Reference

### POST /webhooks/paddle

**Description:** Paddle webhook endpoint for payment events

**Authentication:** None (validated via HMAC signature)

**Note:** This endpoint should be documented in `ENDPOINTS.md` following the same format as other endpoints. It's a public endpoint (no JWT required) but validates requests via HMAC signature, similar to how `/health` validates via API key.

**Request:**
```
POST /webhooks/paddle
Headers:
  Content-Type: application/json
  paddle-signature: <HMAC SHA256 signature>

Body: <Paddle webhook payload>
```

**Response:**
- `200 OK`: Webhook processed (success or non-critical error)
- `401 Unauthorized`: Invalid signature
- `400 Bad Request`: Invalid payload format

**Example Success Response:**
```json
{
  "status": "processed",
  "event_type": "transaction.completed",
  "transaction_id": "txn_01abc123"
}
```

**Error Response Format:**
Follows standard error format from `src/utils/errors.js`:
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid webhook signature",
    "details": {
      "action_required": "verify_webhook_secret"
    }
  }
}
```

---

## Support and Troubleshooting

### Common Issues

1. **Webhook not receiving events:**
   - Verify webhook URL in Paddle dashboard
   - Check API Gateway logs
   - Verify Lambda function is deployed

2. **Signature validation failing:**
   - Verify webhook secret in SSM matches Paddle dashboard
   - Check for trailing whitespace in secret
   - Verify signature header name (`paddle-signature`)

3. **Credits not granted:**
   - Check CloudWatch logs for errors
   - Verify user exists with matching email
   - Check credit mapping for price ID
   - Verify idempotency (transaction may already be processed)

4. **Double crediting:**
   - Check ReferenceIdIndex GSI exists
   - Verify idempotency check is working
   - Review transaction logs

---

## Appendix

### Paddle Webhook Event Types

We currently handle:
- `transaction.completed`: Payment completed, grant credits

Future events (not implemented):
- `transaction.refunded`: Refund processed, deduct credits
- `subscription.created`: Subscription started
- `subscription.canceled`: Subscription canceled

### Credit Calculation Examples

| Price ID | Amount | Credits | Rate |
|----------|--------|---------|------|
| pri_test_10usd | $10.00 | 1000 | 100 credits/$ |
| pri_test_50usd | $50.00 | 6000 | 120 credits/$ |

**Note:** Credit rates can be customized per price ID. The mapping follows the existing credit system where 1 credit = $0.01 USD (as defined in `price_per_pdf` for paid plans).

---

## Revision History

- **2025-01-15:** Initial specification created

