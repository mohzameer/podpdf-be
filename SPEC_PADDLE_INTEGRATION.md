# Paddle Integration Specification (Backend Only)

## Overview

This specification outlines the backend implementation for integrating Paddle payment processing into the PodPDF system. The integration enables users to purchase credits via Paddle's payment gateway, with automatic credit granting through webhook events.

**Key Features:**
- Paddle webhook endpoint for payment events
- Automatic credit granting on successful payment (`transaction.completed`)
- Refund-safe credit revocation via adjustments (`adjustment.created` / `adjustment.updated`)
- Idempotency to prevent double crediting and double refund processing
- Deterministic signature validation (no secrets or keys needed)
- Credit ledger system for audit trail and refund calculations
- Integration with existing credit system

---

## Architecture

### Components

1. **Paddle Webhook Handler** (`src/handlers/paddle-webhook.js`)
   - Receives webhook events from Paddle
   - Validates webhook signatures
   - Routes events to appropriate handlers:
     - `transaction.completed` → grants credits
     - `adjustment.created` / `adjustment.updated` → processes refunds

2. **Paddle Service** (`src/services/paddle.js`)
   - Webhook signature verification
   - Credit mapping logic (price ID → credit amount)
   - User lookup by email
   - Transaction completion handling (credit granting)
   - Adjustment handling (refund processing)

3. **Credit Ledger System**
   - Tracks granted, used, and revoked credits per transaction
   - Enables refund-safe credit revocation (never revokes used credits)
   - Supports full refunds only (revokes all unused credits)

4. **SSM Parameter Store (Optional)**
   - Can store credit mapping configuration (optional, can be hardcoded initially)
   - **Note:** No webhook secrets or public keys needed - Paddle uses deterministic signature validation

---

## Environment Variables (SSM Parameters)

**Note:** Paddle Billing uses deterministic signature validation - no secrets or public keys are required. The signature is verified using a deterministic hash scheme.

### Optional SSM Parameters

#### 1. Credit Mapping (Optional - can be hardcoded initially)
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
- `paddle-signature`: Signature header in format `ts=1234567890,v1=abc123...` where `v1` is SHA256(timestamp + rawBody)

**Request Body:**
Paddle webhook payload (JSON). Key fields:
- `event_type`: Event type (e.g., `transaction.completed`, `adjustment.created`, `adjustment.updated`)
- `data`: Event data containing:
  - For `transaction.completed`:
    - `id`: Transaction ID
    - `customer_id`: Customer ID
    - `customer`: Customer object with `email`
    - `items`: Array of items with `price_id`
    - `totals`: Transaction totals with `total` (USD amount)
  - For `adjustment.created` / `adjustment.updated`:
    - `id`: Adjustment ID
    - `transaction_id`: Original transaction ID
    - `action`: Adjustment action (e.g., `"refund"`)
    - `status`: Adjustment status (e.g., `"approved"`)
    - `totals`: Adjustment totals with `total` (refund amount in USD)

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
- Paddle Billing uses deterministic signature validation (no secret or public key)
- Signature header format: `ts=1234567890,v1=abc123...`
- Compute: `SHA256(timestamp + rawBody)` and compare with `v1` value
- Use `crypto.timingSafeEqual()` for comparison
- Return 401 if signature is invalid

**Event Processing:**
- Route events based on `event_type`:
  - `transaction.completed` → Call `handleTransactionCompleted()`
  - `adjustment.created` / `adjustment.updated` → Call `handleAdjustment()`
  - Other event types → Log and return 200 (ignore)
- Extract relevant data from event payload
- Call appropriate service functions for credit granting or refund processing

**Error Handling:**
- Use existing error utilities from `src/utils/errors.js`
- Log all errors with context using `logger` utility
- Return 200 for processing errors (to prevent Paddle retries on transient issues)
- Return 401 only for signature validation failures using `Unauthorized.MISSING_TOKEN()` or custom error
- Return 400 for invalid payload using `BadRequest.INVALID_PARAMETER()`

### 2. Paddle Service (`src/services/paddle.js`)

**Functions:**

#### `verifyWebhookSignature(signatureHeader, body)`
- Verifies deterministic signature (no secret or key needed)
- Parses signature header: `ts=1234567890,v1=abc123...`
- Computes SHA256(timestamp + rawBody) and compares with v1
- Returns boolean

#### `getCreditAmount(priceId)`
- Maps Paddle price ID to credit amount
- Initially hardcoded mapping
- Can be extended to read from SSM later

#### `handleTransactionCompleted(transactionData)`
- Extracts transaction ID, customer ID, and price ID from transaction data
- Gets credit amount for price ID
- Checks idempotency using credit ledger (prevents double crediting)
- Looks up user by customer ID (or email fallback)
- Creates credit ledger entry
- Grants credits via `purchaseCredits` from business service
- Returns result with transaction details

#### `handleAdjustment(adjustmentData)`
- Filters for refund adjustments only (`action === 'refund'` and `status === 'approved'`)
- Checks idempotency using refund log (prevents double processing)
- Retrieves credit ledger for original transaction
- Calculates unused credits (granted - used - revoked)
- Revokes all unused credits (full refund only - no partial refunds)
- Updates credit ledger and user balance
- Logs refund processing

#### `getCreditAmount(priceId)`
- Maps Paddle price ID to credit amount
- Initially hardcoded mapping
- Can be extended to read from SSM later

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

### 4. Credit Ledger System

**Purpose:**
The credit ledger tracks granted, used, and revoked credits per Paddle transaction. This enables refund-safe credit revocation that never revokes credits that have already been used.

**Credit Ledger Table Structure:**
```javascript
{
  ledger_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", // ULID
  transaction_id: "txn_01abc123", // Paddle transaction ID (partition key)
  user_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  credits_granted: 1000, // Credits granted on transaction.completed
  credits_used: 250, // Credits consumed (updated by credit deduction processor)
  credits_revoked: 0, // Credits revoked due to refunds
  created_at: "2025-01-15T10:30:00.000Z",
  updated_at: "2025-01-15T10:30:00.000Z"
}
```

**Key Operations:**
1. **Create Ledger on Transaction Completion:**
   - Initialize `credits_granted` with credit amount
   - Set `credits_used` and `credits_revoked` to 0
   - Use `transaction_id` as partition key for fast lookups

2. **Update Credits Used:**
   - Credit deduction processor updates `credits_used` when credits are consumed
   - Can be updated asynchronously or via a separate process

3. **Calculate Unused Credits:**
   - Formula: `unusedCredits = credits_granted - credits_used - credits_revoked`
   - Used to determine how many credits can be safely revoked on refund

### 5. Refund Processing Logic

**Paddle Billing Refund Model:**
- Refunds are represented as **adjustments** (not transaction status changes)
- Only `adjustment.created` and `adjustment.updated` events with `action === 'refund'` and `status === 'approved'` trigger refund processing
- Adjustments reference the original transaction via `transaction_id`
- **Note:** This integration only supports **full refunds**. Partial refunds are not supported.

**Refund Processing Steps:**

1. **Filter Valid Refunds:**
   ```javascript
   if (adjustment.action !== 'refund') return; // Ignore non-refund adjustments
   if (adjustment.status !== 'approved') return; // Only process approved refunds
   ```

2. **Idempotency Check:**
   - Check `RefundLog` table for existing entry with `adjustment_id`
   - If exists, skip processing (already handled)

3. **Retrieve Credit Ledger:**
   - Look up credit ledger by `transaction_id` from adjustment
   - If ledger not found, log warning and skip (transaction may not have been processed)

4. **Calculate Unused Credits:**
   ```javascript
   const unusedCredits = ledger.credits_granted - ledger.credits_used - ledger.credits_revoked;
   if (unusedCredits <= 0) {
     // No credits to revoke (all used or already revoked)
     // Mark refund as processed and return
     await markRefundProcessed(adjustmentId);
     return;
   }
   ```

5. **Revoke All Unused Credits (Full Refund Only):**
   - Decrement user's `credits_balance` by `unusedCredits` (all unused credits)
   - Increment ledger's `credits_revoked` by `unusedCredits`
   - Log refund transaction to `CreditTransactions` table (negative amount)

6. **Mark Refund as Processed:**
   - Create entry in `RefundLog` table with `adjustment_id`

**Refund Log Table Structure:**
```javascript
{
  adjustment_id: "adj_01abc123", // Paddle adjustment ID (partition key)
  transaction_id: "txn_01abc123", // Original transaction ID
  refund_amount: "10.00", // USD (full refund amount)
  credits_revoked: 1000, // Credits revoked (all unused credits)
  processed_at: "2025-01-15T11:00:00.000Z"
}
```

**Refund Flow Summary:**

**Flow 1: Full Refund with Unused Credits**
1. User purchases 1000 credits via Paddle
2. Credit ledger created: `credits_granted: 1000, credits_used: 0, credits_revoked: 0`
3. User uses 300 credits (ledger: `credits_used: 300`)
4. Refund webhook received (`adjustment.created` with `action=refund`, `status=approved`)
5. System calculates: `unusedCredits = 1000 - 300 - 0 = 700`
6. System revokes all 700 unused credits
7. User's `credits_balance` decremented by 700
8. Ledger updated: `credits_revoked: 700`
9. Refund logged in `RefundLog` table

**Flow 2: Full Refund with All Credits Used**
1. User purchases 1000 credits via Paddle
2. Credit ledger created: `credits_granted: 1000, credits_used: 0, credits_revoked: 0`
3. User uses all 1000 credits (ledger: `credits_used: 1000`)
4. Refund webhook received
5. System calculates: `unusedCredits = 1000 - 1000 - 0 = 0`
6. No credits to revoke (all used)
7. Refund marked as processed in `RefundLog` (no credit revocation)
8. User keeps their used credits (no negative balance)

**Flow 3: Duplicate Refund Webhook (Idempotency)**
1. Refund webhook received
2. System checks `RefundLog` for `adjustment_id`
3. Entry exists → skip processing, return 200 OK
4. No double revocation

**Flow 4: Refund Before Transaction Processed**
1. Refund webhook received
2. System looks up credit ledger by `transaction_id`
3. Ledger not found → log warning, skip processing, return 200 OK
4. Transaction may not have been processed yet

**Flow 5: Non-Refund Adjustment**
1. Adjustment webhook received with `action !== 'refund'`
2. System ignores (not a refund)
3. Return 200 OK

**Flow 6: Pending Refund**
1. Adjustment webhook received with `status !== 'approved'`
2. System ignores (not approved yet)
3. Return 200 OK (will process when status becomes 'approved')

**Golden Rules:**
- ✅ Grant credits only on `transaction.completed`
- ✅ Detect refunds only via `adjustment.*` events
- ✅ Never revoke used credits (check `credits_used` before revoking)
- ✅ Only support full refunds (revoke all unused credits)
- ✅ Always be idempotent (check refund log before processing)
- ❌ Never trust frontend success callbacks
- ❌ Never mutate the original transaction record
- ❌ Partial refunds are not supported

---

## Credit Mapping

### Initial Hardcoded Mapping

For sandbox and initial production deployment, use hardcoded mapping:

```javascript
const CREDIT_PACKS = {
  // Sandbox price IDs
  'pri_test_10usd': 1000,   // $10 = 1000 credits
  'pri_test_50usd': 6000,   // $50 = 6000 credits
  'pri_test_100usd': 15000, // $100 = 15000 credits
  
  // Production price IDs (to be configured)
  // 'pri_01abc123': 1000,
  // 'pri_01def456': 6000,
};
```

**Credit Calculation:**
- 1 credit = $0.01 USD
- $10 purchase = 1000 credits
- $50 purchase = 6000 credits (or custom rate)
- $100 purchase = 15000 credits (or custom rate)

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
    # PADDLE_CREDIT_MAPPING_SSM: /podpdf/${self:provider.stage}/paddle/credit-mapping  # Optional
```

### IAM Permissions

**Required DynamoDB Permissions:**

The `paddle-webhook` function requires the following DynamoDB permissions:

**Actions:**
- `dynamodb:GetItem` - Read credit ledger, refund log, users, credit transactions
- `dynamodb:PutItem` - Create credit ledger entries, refund log entries, credit transactions
- `dynamodb:UpdateItem` - Update user credit balance, credit ledger (credits_revoked)
- `dynamodb:Query` - Query users by email (EmailIndex), credit transactions by reference_id (ReferenceIdIndex)

**Resources:**
- `UsersTable` and `UsersTable/EmailIndex` - User lookup by email
- `CreditTransactionsTable` and `CreditTransactionsTable/ReferenceIdIndex` - Idempotency checks
- `CreditLedgerTable` and `CreditLedgerTable/UserIdIndex` - Credit ledger operations
- `RefundLogTable` and `RefundLogTable/TransactionIdIndex` - Refund idempotency checks

**Note:** No SSM permissions needed for Paddle webhook verification (deterministic signature validation). If credit mapping is moved to SSM later, add `ssm:GetParameter` permissions then.

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

**For CreditLedgerTable (NEW):**
```yaml
CreditLedgerTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: ${self:custom.tableNames.${self:provider.stage}.creditLedger}
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: transaction_id
        AttributeType: S
      - AttributeName: user_id
        AttributeType: S
    KeySchema:
      - AttributeName: transaction_id
        KeyType: HASH
    GlobalSecondaryIndexes:
      - IndexName: UserIdIndex
        KeySchema:
          - AttributeName: user_id
            KeyType: HASH
        Projection:
          ProjectionType: ALL
    Tags:
      - Key: Stage
        Value: ${self:provider.stage}
      - Key: Service
        Value: podpdf
```

**For RefundLogTable (NEW):**
```yaml
RefundLogTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: ${self:custom.tableNames.${self:provider.stage}.refundLog}
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: adjustment_id
        AttributeType: S
      - AttributeName: transaction_id
        AttributeType: S
    KeySchema:
      - AttributeName: adjustment_id
        KeyType: HASH
    GlobalSecondaryIndexes:
      - IndexName: TransactionIdIndex
        KeySchema:
          - AttributeName: transaction_id
            KeyType: HASH
        Projection:
          ProjectionType: ALL
    Tags:
      - Key: Stage
        Value: ${self:provider.stage}
      - Key: Service
        Value: podpdf
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

### Refund Processing Errors

**Adjustment Not a Refund:**
- Log info message (non-refund adjustment)
- Return `200 OK`
- Skip processing

**Adjustment Not Approved:**
- Log info message (pending/denied refund)
- Return `200 OK`
- Skip processing

**Refund Already Processed:**
- Log info message
- Return `200 OK`
- Skip processing (idempotency)

**Credit Ledger Not Found:**
- Log warning (transaction may not have been processed)
- Return `200 OK`
- Skip processing

**No Unused Credits:**
- Log info message (all credits used or already revoked)
- Mark refund as processed
- Return `200 OK`
- Skip credit revocation

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
   - Configure Paddle Sandbox webhook endpoint URL
   - Deploy to dev stage

2. **Test Cases:**
   - Valid `transaction.completed` event → credits granted, ledger created
   - Duplicate webhook delivery → idempotency check prevents double crediting
   - Invalid signature → 401 response
   - User not found → logged, 200 response
   - Invalid price ID → logged, 200 response
   - Full refund (`adjustment.created` with `action=refund`, `status=approved`) → all unused credits revoked
   - Refund when all credits used → no credits revoked, refund marked as processed
   - Refund when some credits used → only unused credits revoked
   - Duplicate refund webhook → idempotency check prevents double processing
   - Non-refund adjustment → ignored, 200 response
   - Pending refund (`status=pending`) → ignored, 200 response

3. **Verification:**
   - Check CloudWatch logs for webhook events
   - Verify credits in Users table
   - Verify transaction in CreditTransactions table
   - Verify credit ledger created with correct `credits_granted`
   - Verify idempotency (retry webhook, no double credits)
   - Test refund flow: verify unused credits revoked, ledger updated, refund log created
   - Verify full refund revokes all unused credits (never revokes used credits)
   - Verify refund idempotency (retry refund webhook, no double revocation)

### Production Testing

1. **Pre-deployment:**
   - Configure production webhook endpoint in Paddle
   - Configure production webhook endpoint in Paddle dashboard
   - Test with small transaction first

2. **Monitoring:**
   - Set up CloudWatch alarms for webhook errors
   - Monitor credit transaction volume
   - Track failed user lookups

---

## Security Considerations

### Signature Validation
- Paddle Billing uses deterministic signature validation (no secrets or keys)
- Always validate signatures using the deterministic hash scheme
- Keep raw request body (do not JSON-parse before verification)
- Use `crypto.timingSafeEqual()` for signature comparison
- Return generic errors to prevent information leakage

### Data Privacy
- Mask email addresses in logs (e.g., `u***@example.com`)
- Do not log full transaction payloads
- Comply with data retention policies

---

## Deployment Checklist

### Pre-deployment
- [ ] Configure Paddle Sandbox webhook endpoint URL
- [ ] Test webhook signature verification locally
- [ ] Review credit mapping configuration
- **Note:** No secrets or public keys needed - Paddle uses deterministic signature validation

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
- [ ] Configure production webhook endpoint in Paddle
- [ ] Update credit mapping with production price IDs
- [ ] Test with small transaction
- [ ] Monitor for 24-48 hours before full rollout
- **Note:** No secrets or public keys needed - Paddle uses deterministic signature validation

---

## Future Enhancements

### Phase 2 (Optional)
1. **Dynamic Credit Mapping:** Move credit mapping to SSM Parameter Store
2. **Paddle Customer ID Mapping:** Store Paddle customer ID → user_id mapping for faster lookups
3. **Webhook Retry Logic:** Implement exponential backoff for failed credit grants
4. **Admin Dashboard:** View Paddle transactions, credit grants, and refunds
5. **Credit Usage Tracking:** Real-time updates to `credits_used` in credit ledger (currently requires separate process)

**Note:** 
- Email GSI is now included in Phase 1 implementation (not optional) for efficient user lookups.
- Refund handling via adjustments is now included in Phase 1 implementation (not optional).

---

## API Reference

### POST /webhooks/paddle

**Description:** Paddle webhook endpoint for payment events

**Authentication:** None (validated via deterministic signature - no secret or key needed)

**Note:** This endpoint should be documented in `ENDPOINTS.md` following the same format as other endpoints. It's a public endpoint (no JWT required) but validates requests via deterministic signature, similar to how `/health` validates via API key.

**Request:**
```
POST /webhooks/paddle
Headers:
  Content-Type: application/json
  paddle-signature: ts=1234567890,v1=abc123...

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
      "action_required": "verify_signature_format"
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
   - Verify signature header format: `ts=1234567890,v1=abc123...`
   - Ensure raw body is used (not JSON-parsed) for verification
   - Check that timestamp and v1 values are present in header
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

5. **Refunds not processing:**
   - Verify adjustment has `action === 'refund'` and `status === 'approved'`
   - Check credit ledger exists for transaction
   - Verify unused credits available (granted - used - revoked > 0)
   - Check refund log for duplicate processing

6. **Credits revoked incorrectly:**
   - Check that only unused credits are revoked (never revoke used credits)
   - Verify full refund revokes all unused credits (not partial)
   - Review credit ledger: `credits_used` should be accurate

---

## Appendix

### Paddle Webhook Event Types

We currently handle:
- `transaction.completed`: Payment completed, grant credits
- `adjustment.created`: Adjustment created (process if refund and approved)
- `adjustment.updated`: Adjustment updated (process if refund and approved)

**Event Processing Logic:**
- `transaction.completed`: Always process (grant credits)
- `adjustment.created` / `adjustment.updated`: Only process if `action === 'refund'` and `status === 'approved'`
- All other events: Log and ignore (return 200)

**Note:** This integration only handles one-time purchases (prepaid credits). Subscription events are not supported.

### Credit Calculation Examples

| Price ID | Amount | Credits | Rate |
|----------|--------|---------|------|
| pri_test_10usd | $10.00 | 1000 | 100 credits/$ |
| pri_test_50usd | $50.00 | 6000 | 120 credits/$ |

**Note:** Credit rates can be customized per price ID. The mapping follows the existing credit system where 1 credit = $0.01 USD (as defined in `price_per_pdf` for paid plans).

---

## Revision History

- **2025-01-15:** Initial specification created
- **2025-01-15:** Added adjustment-based refund handling, credit ledger system, and refund-safe credit revocation

