# Credit-Based Billing System Specification

**Version:** 1.0.0  
**Date:** December 2025  
**Status:** Draft - Architecture Analysis

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Analysis](#current-state-analysis)
3. [New Requirements](#new-requirements)
4. [Architecture Options](#architecture-options)
5. [Complexity Analysis](#complexity-analysis)
6. [Recommended Solution](#recommended-solution)
7. [Implementation Plan](#implementation-plan)
8. [Migration Strategy](#migration-strategy)

---

## Executive Summary

This specification outlines the transition from a **pay-as-you-go with monthly invoicing** model to a **prepaid credit-based system** where users purchase credits upfront and credits are deducted per PDF generation.

**Key Challenge:** Ensuring reliable credit deduction under high concurrency (10,000+ concurrent operations) without race conditions, lost credits, or double-charging.

**Current System Limitations:**
- Monthly invoicing model requires payment processor integration
- `free_credits_remaining` can go negative due to concurrent requests (known issue)
- No prepaid credit balance tracking

**New System Requirements:**
- Prepaid credits stored per user
- Atomic credit deduction (no race conditions)
- Handle 10,000+ concurrent operations reliably
- Prevent double-charging and lost credits
- Real-time credit balance updates

---

## Current State Analysis

### Current Billing Model

**Free Tier:**
- 50 PDFs all-time quota (configurable per plan)
- No billing charges
- Quota tracked in `Users.total_pdf_count`

**Paid Plan:**
- Unlimited PDFs
- `free_credits` (e.g., 100 free PDFs) consumed first
- $0.01 per PDF after free credits exhausted
- Monthly billing records in `Bills` table
- Invoicing at end of month (not yet implemented)

### Current Implementation

**Credit Deduction Flow (from `business.js`):**
```javascript
// Atomically decrement free_credits_remaining
const updatedUser = await updateItem(
  USERS_TABLE,
  { user_id: userId },
  'SET free_credits_remaining = if_not_exists(free_credits_remaining, :zero) - :dec',
  { ':zero': 0, ':dec': 1 }
);

const remainingCredits = updatedUser.free_credits_remaining;

// Charge only if free credits are exhausted (<= 0)
if (remainingCredits <= 0) {
  billingIncrement = plan.price_per_pdf;
  // Creates/updates bill record in Bills table
}
```

**Known Issues:**
1. **Concurrent Request Problem:** `free_credits_remaining` can go negative (e.g., `-1`, `-2`) due to race conditions
2. **No Prepaid Balance:** System only tracks free credits and monthly billing, not prepaid credits
3. **Monthly Invoicing:** Requires payment processor integration (not yet implemented)
4. **No Credit Purchase Flow:** No mechanism to add credits to user account

### Current Data Model

**Users Table:**
- `user_id` (partition key)
- `total_pdf_count` (all-time PDF count)
- `free_credits_remaining` (can go negative)
- `plan_id`
- `account_status`

**Bills Table:**
- `user_id` (partition key)
- `billing_month` (sort key)
- `monthly_pdf_count`
- `monthly_billing_amount`
- `is_paid` (default: false)

**Plans Table:**
- `plan_id` (partition key)
- `price_per_pdf`
- `free_credits`

---

## New Requirements

### Functional Requirements

1. **Credit Balance Management:**
   - Users purchase credits upfront (via payment processor)
   - Credits stored per user in `Users` table
   - Real-time balance updates after each PDF generation
   - Balance cannot go negative (hard limit)

2. **Credit Deduction:**
   - Atomic deduction per PDF generation
   - Must prevent race conditions (10,000+ concurrent operations)
   - No double-charging
   - No lost credits
   - Immediate rejection if insufficient credits

3. **Credit Purchase:**
   - Users can purchase credits via payment processor
   - Credits added to balance atomically
   - Purchase history tracked

4. **Pricing:**
   - Price per PDF: $0.01 (from `plan.price_per_pdf`)
   - Credits denominated in USD (1 credit = $0.01)
   - Minimum purchase amount (e.g., $10 = 1000 credits)

5. **Backward Compatibility:**
   - Free tier users unaffected (no credits required)
   - Existing paid users migrate to credit system
   - Free credits still consumed first (if plan has `free_credits`)

### Non-Functional Requirements

1. **Reliability:**
   - 99.99% accuracy in credit deduction
   - No lost credits under any concurrency scenario
   - No double-charging

2. **Performance:**
   - Handle 10,000+ concurrent credit deductions
   - Credit check + deduction: < 50ms p99 latency
   - No degradation under high load

3. **Scalability:**
   - Support millions of users
   - Support millions of credit transactions per day
   - Horizontal scaling (serverless architecture)

4. **Consistency:**
   - Strong consistency for credit balance (no eventual consistency)
   - Immediate visibility of balance changes

---

## Architecture Options

### Option 1: DynamoDB Conditional Updates (Optimistic Locking)

**Description:**
Use DynamoDB conditional updates with version numbers or timestamps to prevent race conditions.

**Implementation:**
```javascript
// Add version field to Users table
const user = await getItem(USERS_TABLE, { user_id: userId });
const currentVersion = user.version || 0;
const currentCredits = user.credits_balance || 0;

if (currentCredits < costPerPdf) {
  return { error: 'INSUFFICIENT_CREDITS' };
}

// Conditional update: only succeed if version hasn't changed
try {
  const updated = await updateItem(
    USERS_TABLE,
    { user_id: userId },
    'SET credits_balance = credits_balance - :cost, version = version + :inc',
    { ':cost': costPerPdf, ':inc': 1 },
    { '#version': 'version' },
    'version = :currentVersion', // Condition
    { ':currentVersion': currentVersion }
  );
  return { success: true, newBalance: updated.credits_balance };
} catch (ConditionalCheckFailedException) {
  // Retry with exponential backoff
  return retryCreditDeduction(userId, costPerPdf);
}
```

**Pros:**
- Simple implementation (uses existing DynamoDB)
- No additional infrastructure
- Strong consistency (DynamoDB guarantees)
- Low latency (single DynamoDB operation)

**Cons:**
- Retry logic required (can add latency under high contention)
- Version conflicts under extreme concurrency (10,000+ concurrent)
- Potential for retry storms
- Higher DynamoDB write costs (failed conditional updates still consume WCU)

**Scalability:**
- Good for moderate concurrency (< 1,000 concurrent)
- Degrades under extreme concurrency (10,000+)
- Retry storms can cause cascading failures

**Complexity:** Low-Medium

---

### Option 2: DynamoDB Transactions

**Description:**
Use DynamoDB transactions to atomically check and deduct credits in a single operation.

**Implementation:**
```javascript
// Use DynamoDB TransactWriteItems
const transaction = {
  TransactItems: [
    {
      Update: {
        TableName: USERS_TABLE,
        Key: { user_id: userId },
        UpdateExpression: 'SET credits_balance = credits_balance - :cost',
        ConditionExpression: 'credits_balance >= :cost',
        ExpressionAttributeValues: {
          ':cost': costPerPdf
        }
      }
    },
    {
      Put: {
        TableName: CREDIT_TRANSACTIONS_TABLE,
        Item: {
          transaction_id: generateULID(),
          user_id: userId,
          amount: -costPerPdf,
          job_id: jobId,
          timestamp: new Date().toISOString()
        }
      }
    }
  ]
};

await docClient.send(new TransactWriteCommand(transaction));
```

**Pros:**
- Atomic operation (all-or-nothing)
- Strong consistency guaranteed
- No race conditions
- Can include transaction logging in same operation

**Cons:**
- **Limited throughput:** DynamoDB transactions limited to 25 items, 4MB total
- **Higher cost:** Transactions cost 2x WCU (write capacity units)
- **Lower concurrency:** Transactions are serialized per item (hot partition problem)
- **Latency:** Slightly higher latency than single update (~10-20ms)

**Scalability:**
- **Poor for high concurrency:** Hot partition on `user_id` limits throughput
- **Bottleneck:** All transactions for same user serialized
- **Not suitable for 10,000+ concurrent:** Would create massive queue

**Complexity:** Medium

---

### Option 3: Queue-Based Credit Deduction

**Description:**
Queue credit deduction requests and process them sequentially per user to avoid race conditions. **Key Principle:** Deduct credits ONLY after PDF is successfully generated. This ensures customers are never overcharged, even if some PDFs are lost.

**Architecture:**
```
PDF Generation Request
  ↓
Check Credits (read-only, fast)
  ↓
If sufficient: Generate PDF first
  ↓
PDF Generation Succeeds?
  ├─ YES → Queue credit deduction (with job_id)
  └─ NO → No deduction, return error
  ↓
Process Credit Deduction (async, sequential per user)
  - Uses job_id as idempotency key
  - Prevents double-charging
```

**Implementation:**
```javascript
// Step 1: Fast credit check (read-only)
const user = await getItem(USERS_TABLE, { user_id: userId });
if (user.credits_balance < costPerPdf) {
  return { error: 'INSUFFICIENT_CREDITS' };
}

// Step 2: Generate PDF first
const pdfResult = await generatePdf(...);
if (!pdfResult.success) {
  // PDF generation failed - NO deduction message sent
  return { error: 'PDF_GENERATION_FAILED' };
}

// Step 3: Only queue deduction AFTER PDF succeeds
await sendMessageToSQS(CREDIT_DEDUCTION_QUEUE, {
  MessageGroupId: userId, // Sequential processing per user
  MessageDeduplicationId: jobId, // FIFO deduplication by job_id
  MessageBody: JSON.stringify({
    user_id: userId,
    amount: costPerPdf,
    job_id: jobId,
    timestamp: Date.now()
  })
});

// Step 4: Credit deduction processor (FIFO queue)
// - Uses job_id as idempotency key
// - Checks transaction log before deducting
// - Prevents double-charging even with duplicate messages
```

**Pros:**
- **No race conditions:** Sequential processing per user (FIFO queue)
- **No overcharging:** Credits deducted only after PDF success + idempotency prevents duplicates
- **High throughput:** Can process millions of deductions per day
- **Reliable:** SQS FIFO guarantees exactly-once processing (with deduplication)
- **Scalable:** Horizontal scaling via Lambda concurrency
- **Acceptable losses:** If deduction fails after PDF generation, PDF is lost but customer not charged

**Cons:**
- **Eventual consistency:** Credit deduction happens async (few seconds delay)
- **Complexity:** Two-phase system (generate PDF + queue deduction)
- **Acceptable edge case:** PDF generated but deduction fails = lost PDF (acceptable trade-off)
- **Additional infrastructure:** SQS FIFO queue + processor Lambda

**Scalability:**
- **Excellent:** Can handle millions of transactions
- **No hot partition:** Queue distributes load
- **Suitable for 10,000+ concurrent:** Queue absorbs spikes

**Complexity:** High

---

### Option 4: Distributed Lock (Redis/DynamoDB)

**Description:**
Use distributed locks to serialize credit deductions per user.

**Implementation:**
```javascript
// Acquire lock (with TTL)
const lockKey = `credit_lock:${userId}`;
const lockAcquired = await acquireLock(lockKey, 5); // 5 second TTL

if (!lockAcquired) {
  return { error: 'LOCK_TIMEOUT', retry: true };
}

try {
  // Deduct credits
  const user = await getItem(USERS_TABLE, { user_id: userId });
  if (user.credits_balance < costPerPdf) {
    return { error: 'INSUFFICIENT_CREDITS' };
  }
  
  await updateItem(
    USERS_TABLE,
    { user_id: userId },
    'SET credits_balance = credits_balance - :cost',
    { ':cost': costPerPdf }
  );
  
  return { success: true };
} finally {
  await releaseLock(lockKey);
}
```

**Pros:**
- Prevents race conditions
- Strong consistency
- Can use DynamoDB for locks (no Redis needed)

**Cons:**
- **Serialization bottleneck:** All requests for same user wait
- **Lock contention:** High concurrency causes timeouts
- **Complexity:** Lock management, TTL, deadlock handling
- **Latency:** Lock acquisition adds overhead

**Scalability:**
- **Poor for high concurrency:** Lock contention creates queue
- **Not suitable for 10,000+ concurrent:** Would timeout most requests

**Complexity:** Medium-High

---

### Option 5: Event Sourcing with Credit Ledger

**Description:**
Store all credit transactions in an append-only ledger, calculate balance from events.

**Architecture:**
```
CreditTransaction Table (Event Store)
  - transaction_id (partition key)
  - user_id (GSI)
  - amount (positive for purchases, negative for deductions)
  - job_id
  - timestamp
  - status (pending, completed, failed)

Users Table (Materialized View)
  - credits_balance (cached, eventually consistent)
  - last_transaction_id (for reconciliation)
```

**Implementation:**
```javascript
// Step 1: Append credit deduction event
const transaction = {
  transaction_id: generateULID(),
  user_id: userId,
  amount: -costPerPdf,
  job_id: jobId,
  timestamp: Date.now(),
  status: 'pending'
};

await putItem(CREDIT_TRANSACTIONS_TABLE, transaction);

// Step 2: Calculate balance from events
const balance = await calculateBalanceFromEvents(userId);

// Step 3: If sufficient, mark transaction as completed
if (balance >= 0) {
  await updateItem(
    CREDIT_TRANSACTIONS_TABLE,
    { transaction_id: transaction.transaction_id },
    'SET status = :completed',
    { ':completed': 'completed' }
  );
  
  // Update materialized view (async)
  await updateUserBalance(userId, balance);
} else {
  // Reject transaction
  await updateItem(..., 'SET status = :failed', { ':failed': 'failed' });
}
```

**Pros:**
- **Audit trail:** Complete history of all transactions
- **No lost data:** Events are append-only
- **Reconciliation:** Can recalculate balance from events
- **Scalable:** Append-only writes are fast

**Cons:**
- **Eventual consistency:** Balance calculation can lag
- **Complexity:** Event sourcing adds significant complexity
- **Performance:** Balance calculation requires querying events
- **Overkill:** For simple credit system, may be too complex

**Scalability:**
- **Good:** Append-only writes scale well
- **Balance calculation:** Can be bottleneck (needs optimization)

**Complexity:** Very High

---

### Option 6: Hybrid Approach (Fast Check + Async Deduction)

**Description:**
Fast optimistic check with async queue-based deduction for reliability.

**Architecture:**
```
Request Flow:
1. Fast credit check (read-only, cached if possible)
2. If sufficient: Proceed with PDF generation + Queue deduction
3. Async: Process credit deduction sequentially per user
4. If deduction fails: Mark job for refund/retry
```

**Implementation:**
```javascript
// Step 1: Fast optimistic check (with small buffer)
const user = await getItem(USERS_TABLE, { user_id: userId });
const reservedCredits = user.reserved_credits || 0; // Track in-flight deductions
const availableCredits = user.credits_balance - reservedCredits;

if (availableCredits < costPerPdf) {
  return { error: 'INSUFFICIENT_CREDITS' };
}

// Step 2: Reserve credits (optimistic, can go slightly negative)
await updateItem(
  USERS_TABLE,
  { user_id: userId },
  'SET reserved_credits = if_not_exists(reserved_credits, :zero) + :cost',
  { ':zero': 0, ':cost': costPerPdf }
);

// Step 3: Queue actual deduction (async, sequential per user)
await sendMessageToSQS(CREDIT_DEDUCTION_QUEUE, {
  user_id: userId,
  amount: costPerPdf,
  job_id: jobId
});

// Step 4: Process PDF (proceed immediately)

// Step 5: Credit deduction processor (FIFO queue, sequential per user)
// - Deduct from credits_balance
// - Decrement reserved_credits
// - If balance goes negative, handle refund/retry
```

**Pros:**
- **Fast response:** Optimistic check allows immediate PDF processing
- **Reliable:** Queue ensures sequential processing
- **Handles edge cases:** Reserved credits prevent over-allocation
- **Scalable:** Queue absorbs spikes

**Cons:**
- **Complexity:** Two-phase system (reserve + deduct)
- **Edge cases:** Need to handle reserved credits cleanup
- **Eventual consistency:** Actual deduction happens async

**Scalability:**
- **Excellent:** Can handle 10,000+ concurrent
- **Queue-based:** No hot partition issues

**Complexity:** High

---

## Complexity Analysis

### Comparison Matrix

| Option | Reliability | Performance | Scalability (10K+) | Complexity | Cost | Latency |
|--------|------------|-------------|-------------------|------------|------|---------|
| **1. Conditional Updates** | Medium | High | Poor | Low-Medium | Low | Low |
| **2. DynamoDB Transactions** | High | Medium | Poor | Medium | Medium | Medium |
| **3. Queue-Based** | High | High | Excellent | High | Medium | Medium (async) |
| **4. Distributed Lock** | High | Medium | Poor | Medium-High | Low | Medium |
| **5. Event Sourcing** | Very High | Medium | Good | Very High | Medium | Medium |
| **6. Hybrid (Fast + Queue)** | High | High | Excellent | High | Medium | Low (check) |

### Detailed Analysis

#### Option 1: Conditional Updates (Optimistic Locking)

**Reliability:** ⚠️ Medium
- Race conditions possible under extreme concurrency
- Retry logic can fail under sustained load
- Version conflicts cause retries

**Performance:** ✅ High
- Single DynamoDB operation
- Low latency (~10-20ms)
- No additional infrastructure

**Scalability (10K+):** ❌ Poor
- Hot partition on `user_id`
- Retry storms under high contention
- Degrades significantly with 10,000+ concurrent

**Complexity:** ✅ Low-Medium
- Simple implementation
- Retry logic adds some complexity

**Verdict:** ❌ **Not suitable for 10,000+ concurrent operations**

---

#### Option 2: DynamoDB Transactions

**Reliability:** ✅ High
- Atomic operations
- No race conditions
- Strong consistency

**Performance:** ⚠️ Medium
- 2x WCU cost
- Slightly higher latency
- Serialized per item

**Scalability (10K+):** ❌ Poor
- **Critical bottleneck:** Hot partition serializes all transactions per user
- Cannot handle 10,000+ concurrent for same user
- Would create massive queue

**Complexity:** ⚠️ Medium
- Transaction management
- Error handling

**Verdict:** ❌ **Not suitable for 10,000+ concurrent operations**

---

#### Option 3: Queue-Based Credit Deduction

**Reliability:** ✅ High
- Sequential processing per user (FIFO queue)
- No race conditions
- SQS guarantees delivery

**Performance:** ✅ High
- Queue absorbs spikes
- Horizontal scaling
- Can process millions per day

**Scalability (10K+):** ✅ Excellent
- Queue distributes load
- No hot partition
- Handles 10,000+ concurrent easily

**Complexity:** ⚠️ High
- Two-phase system
- Error handling (refunds)
- Additional infrastructure

**Verdict:** ✅ **Suitable for 10,000+ concurrent operations**

---

#### Option 4: Distributed Lock

**Reliability:** ✅ High
- Prevents race conditions
- Strong consistency

**Performance:** ⚠️ Medium
- Lock acquisition overhead
- Serialization causes delays

**Scalability (10K+):** ❌ Poor
- Lock contention creates queue
- Timeouts under high concurrency
- Not suitable for 10,000+ concurrent

**Complexity:** ⚠️ Medium-High
- Lock management
- TTL and deadlock handling

**Verdict:** ❌ **Not suitable for 10,000+ concurrent operations**

---

#### Option 5: Event Sourcing

**Reliability:** ✅✅ Very High
- Complete audit trail
- Can recalculate balance
- No lost data

**Performance:** ⚠️ Medium
- Balance calculation overhead
- Eventual consistency

**Scalability (10K+):** ⚠️ Good
- Append-only writes scale
- Balance calculation can be bottleneck

**Complexity:** ❌ Very High
- Event sourcing complexity
- Materialized views
- Reconciliation logic

**Verdict:** ⚠️ **Overkill for simple credit system**

---

#### Option 6: Hybrid (Fast Check + Queue)

**Reliability:** ✅ High
- Optimistic check + reliable queue
- Handles edge cases

**Performance:** ✅ High
- Fast response (optimistic)
- Queue handles reliability

**Scalability (10K+):** ✅ Excellent
- Queue absorbs spikes
- No hot partition
- Handles 10,000+ concurrent

**Complexity:** ⚠️ High
- Two-phase system
- Reserved credits management
- Error handling

**Verdict:** ✅ **Best balance for 10,000+ concurrent operations**

---

## Recommended Solution

### Primary Recommendation: **Option 3 - Queue-Based Credit Deduction**

**Rationale:**
1. **Proven scalability:** Queue-based systems handle high concurrency well
2. **No race conditions:** Sequential processing per user eliminates conflicts
3. **Reliable:** SQS guarantees at-least-once delivery
4. **Serverless-friendly:** Fits existing Lambda architecture
5. **Cost-effective:** SQS is very cheap ($0.40 per million requests)

**Architecture:**
```
┌─────────────────┐
│  PDF Request    │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────┐
│ 1. Fast Credit Check        │
│    (Read-only, cached)      │
└────────┬────────────────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
┌─────────┐ ┌──────────────────┐
│ Reject  │ │ Queue Deduction  │
│ (if <0) │ │ + Process PDF    │
└─────────┘ └────────┬─────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │ SQS FIFO Queue        │
         │ (MessageGroupId:      │
         │  user_id)             │
         └───────────┬───────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │ Credit Deduction      │
         │ Processor (Lambda)    │
         │ (Sequential per user) │
         └───────────┬───────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │ Update Users Table    │
         │ (credits_balance)     │
         └───────────────────────┘
```

**Implementation Details:**

1. **Fast Credit Check (Synchronous):**
   - Read `credits_balance` from `Users` table
   - If `credits_balance < costPerPdf`, reject immediately with `INSUFFICIENT_CREDITS` error
   - If sufficient, proceed to PDF generation

2. **Generate PDF First:**
   - Generate PDF synchronously (for quickjob) or queue job (for longjob)
   - **Critical:** Only proceed to credit deduction if PDF generation succeeds
   - If PDF generation fails/timeouts, return error (no deduction message sent)

3. **Queue Credit Deduction (Only After PDF Success):**
   - Send message to SQS FIFO queue
   - Use `user_id` as `MessageGroupId` (ensures sequential processing per user)
   - Use `job_id` as `MessageDeduplicationId` (FIFO deduplication prevents duplicate processing)
   - Include: `user_id`, `amount`, `job_id`, `timestamp`
   - **Note:** If queue message fails to send, PDF is lost but customer not charged (acceptable)

4. **Credit Deduction Processor:**
   - Lambda triggered by SQS FIFO queue
   - Processes one message at a time per `MessageGroupId` (user)
   - **Idempotency Check:** Before deducting, check if transaction with this `job_id` already exists
   - If already processed, skip (prevents double-charging from duplicate messages)
   - If not processed, atomically deduct credits from `Users.credits_balance`
   - Log transaction to `CreditTransactions` table with `job_id` for audit
   - If deduction fails (insufficient credits discovered later), mark as failed (no refund needed - PDF was already generated)

**Data Model Changes:**

**Users Table (add):**
- `credits_balance` (Number) - Prepaid credit balance in USD (e.g., 10.50 = $10.50)
- `credits_purchased_at` (String, ISO 8601, optional) - Last purchase timestamp
- `credits_last_updated_at` (String, ISO 8601, optional) - Last deduction timestamp

**New Table: CreditTransactions**
- **Partition Key:** `transaction_id` (ULID)
- **Global Secondary Indexes:**
  - `UserIdIndex` on `user_id` (for querying user's transaction history)
  - `JobIdIndex` on `job_id` (for idempotency checks - prevents double-charging)
- **Attributes:**
  - `transaction_id` (String, ULID) - Unique transaction ID
  - `user_id` (String, ULID) - User identifier
  - `amount` (Number) - Transaction amount (positive for purchases, negative for deductions)
  - `job_id` (String, UUID, optional) - Associated job ID (for deductions, used as idempotency key)
  - `transaction_type` (String) - `"purchase"` or `"deduction"`
  - `status` (String) - `"completed"`, `"failed"`
  - `created_at` (String, ISO 8601) - Transaction timestamp
  - `processed_at` (String, ISO 8601, optional) - When deduction was processed
  - **Note:** `job_id` is used as idempotency key - if transaction with same `job_id` exists, skip deduction

**SQS FIFO Queue:**
- **Queue Name:** `podpdf-{stage}-credit-deduction-queue.fifo`
- **Type:** FIFO (First-In-First-Out)
- **MessageGroupId:** `user_id` (ensures sequential processing per user)
- **MessageDeduplicationId:** `job_id` (FIFO deduplication prevents duplicate processing)
- **Deduplication Scope:** Message content-based (uses MessageDeduplicationId)
- **Visibility Timeout:** 60 seconds
- **Message Retention:** 14 days
- **Dead-Letter Queue:** For failed deductions after max retries

**Error Handling & Guarantees:**

**Never Overcharge Guarantee:**
1. **PDF Generated First:** Credits only deducted after PDF generation succeeds
2. **Idempotency:** `job_id` used as deduplication key prevents double-charging
3. **Transaction Logging:** Every deduction logged with `job_id` for audit trail
4. **FIFO Deduplication:** SQS FIFO queue deduplicates messages with same `MessageDeduplicationId` (job_id)

**Acceptable Losses (PDF Lost, Customer Not Charged):**
- **PDF generated but queue message fails:** PDF is lost, customer not charged ✅
- **PDF generated but deduction processor fails:** PDF is lost, customer not charged ✅
- **PDF generated but insufficient credits discovered later:** PDF is lost, customer not charged ✅

**Error Scenarios:**
- **Insufficient Credits (after queue):** Mark transaction as failed, log for manual review (PDF already generated, acceptable loss)
- **DynamoDB Errors:** Retry with exponential backoff (SQS handles automatically)
- **Lambda Timeout:** Message returns to queue, retried (idempotency check prevents double-charging)
- **Duplicate Messages:** FIFO deduplication + idempotency check prevents double-charging

**Performance Characteristics:**
- **Credit Check Latency:** ~10-20ms (single DynamoDB read)
- **PDF Processing:** Proceeds immediately (no waiting)
- **Credit Deduction:** Async, typically completes within 1-5 seconds
- **Throughput:** Can handle millions of transactions per day
- **Concurrency:** No limit (queue absorbs spikes)

**Never Overcharge Guarantee - Implementation:**

The system is designed with a **"never overcharge"** guarantee as the highest priority. Here's how it's enforced:

1. **PDF Generated First:**
   ```javascript
   // In quickjob/longjob handler
   const pdfResult = await generatePdf(...);
   if (!pdfResult.success) {
     // PDF failed - NO deduction message sent
     return { error: 'PDF_GENERATION_FAILED' };
   }
   
   // Only queue deduction AFTER PDF succeeds
   await sendMessageToSQS(CREDIT_DEDUCTION_QUEUE, {
     MessageGroupId: userId,
     MessageDeduplicationId: jobId, // FIFO deduplication
     MessageBody: JSON.stringify({ user_id, amount, job_id })
   });
   ```

2. **FIFO Queue Deduplication:**
   - SQS FIFO queue uses `MessageDeduplicationId` (job_id) to deduplicate messages
   - If same `job_id` is sent twice, only one message is processed
   - Deduplication window: 5 minutes (messages with same deduplication ID within 5 minutes are deduplicated)

3. **Idempotency Check in Processor:**
   ```javascript
   // In credit-deduction-processor Lambda
   const existingTransaction = await queryItems(
     CREDIT_TRANSACTIONS_TABLE,
     'job_id = :job_id',
     { ':job_id': jobId },
     'JobIdIndex' // GSI on job_id
   );
   
   if (existingTransaction && existingTransaction.length > 0) {
     const tx = existingTransaction[0];
     if (tx.status === 'completed') {
       // Already processed - skip (prevent double-charging)
       logger.info('Transaction already processed', { job_id });
       return { skipped: true, reason: 'already_processed' };
     }
   }
   
   // Deduct credits atomically
   await updateItem(
     USERS_TABLE,
     { user_id: userId },
     'SET credits_balance = credits_balance - :cost',
     { ':cost': amount },
     {},
     'credits_balance >= :cost' // Conditional: only if sufficient
   );
   
   // Log transaction
   await putItem(CREDIT_TRANSACTIONS_TABLE, {
     transaction_id: generateULID(),
     job_id: jobId, // Used for idempotency
     user_id: userId,
     amount: -amount,
     status: 'completed',
     created_at: new Date().toISOString()
   });
   ```

4. **Layered Protection:**
   - **Layer 1:** FIFO queue deduplication (prevents duplicate messages)
   - **Layer 2:** Idempotency check in processor (prevents duplicate processing)
   - **Layer 3:** Transaction logging (audit trail for reconciliation)

**Acceptable Losses (PDF Lost, Customer Not Charged):**
- If PDF is generated but queue message fails to send → PDF lost, customer not charged ✅
- If PDF is generated but deduction processor fails → PDF lost, customer not charged ✅
- If PDF is generated but insufficient credits discovered later → PDF lost, customer not charged ✅

These scenarios are acceptable trade-offs to guarantee customers are never overcharged.

---

### Alternative Recommendation: **Option 6 - Hybrid Approach**

If **real-time balance updates** are critical (users must see balance immediately), use the hybrid approach:

1. **Fast optimistic check** with reserved credits
2. **Queue-based deduction** for reliability
3. **Reserved credits** prevent over-allocation

This adds complexity but provides faster balance visibility.

---

## Implementation Plan

### Phase 1: Data Model & Infrastructure (Week 1)

1. **Add `credits_balance` to Users Table:**
   - Add field to existing `Users` table
   - Migrate existing users (set to 0 or based on current billing)

2. **Create CreditTransactions Table:**
   - Partition key: `transaction_id`
   - GSI: `UserIdIndex` on `user_id`
   - Deploy via Serverless Framework

3. **Create SQS FIFO Queue:**
   - Queue name: `podpdf-{stage}-credit-deduction-queue`
   - Configure MessageGroupId support
   - Set up dead-letter queue

4. **Create Credit Deduction Processor Lambda:**
   - Trigger: SQS FIFO queue
   - Function: `credit-deduction-processor`
   - Memory: 512 MB
   - Timeout: 60 seconds

### Phase 2: Credit Deduction Logic (Week 2)

1. **Update `incrementPdfCount` function:**
   - Add fast credit check (read `credits_balance`)
   - If insufficient, reject with `INSUFFICIENT_CREDITS` error
   - If sufficient, queue credit deduction message

2. **Implement Credit Deduction Processor:**
   - Process SQS FIFO messages sequentially per user
   - **Idempotency Check:** Query `CreditTransactions` table by `job_id` (using JobIdIndex GSI)
   - If transaction with same `job_id` exists and status is `"completed"`, skip (prevent double-charging)
   - If not exists or status is `"failed"`, proceed with deduction
   - Atomically deduct credits from `Users.credits_balance` (with conditional check: `credits_balance >= amount`)
   - Log transaction to `CreditTransactions` table with `job_id` for audit
   - Handle errors (insufficient credits discovered later, DynamoDB errors) - mark as failed, no refund needed

3. **Update Error Handling:**
   - Add `INSUFFICIENT_CREDITS` error code
   - Update API responses

### Phase 3: Credit Purchase Flow (Week 3)

1. **Create Credit Purchase Endpoint:**
   - `POST /accounts/me/credits/purchase`
   - Integrate with payment processor (Stripe, Paddle, etc.)
   - On successful payment, add credits to balance

2. **Credit Purchase Logic:**
   - Create transaction record in `CreditTransactions` table
   - Atomically add credits to `Users.credits_balance`
   - Update `credits_purchased_at` timestamp

3. **Credit Balance Endpoint:**
   - `GET /accounts/me/credits`
   - Return current balance, purchase history

### Phase 4: Testing & Migration (Week 4)

1. **Load Testing:**
   - Test with 10,000+ concurrent requests
   - Verify no race conditions
   - Verify no lost credits
   - Measure latency and throughput

2. **Migration Script:**
   - Migrate existing paid users to credit system
   - Set initial credit balance (based on current billing or zero)
   - Preserve billing history

3. **Monitoring:**
   - CloudWatch metrics for credit deductions
   - Alert on failed deductions
   - Alert on queue depth
   - Dashboard for credit transactions

### Phase 5: Documentation & Rollout (Week 5)

1. **API Documentation:**
   - Update ENDPOINTS.md with credit endpoints
   - Document error codes
   - Migration guide for existing users

2. **Gradual Rollout:**
   - Enable for new users first
   - Migrate existing users in batches
   - Monitor for issues

---

## Migration Strategy

### For Existing Users

1. **Paid Users:**
   - Set `credits_balance` to 0 initially
   - Users must purchase credits to continue
   - Preserve billing history in `Bills` table

2. **Free Tier Users:**
   - No changes (still use quota system)
   - `credits_balance` remains null/0

3. **Users with Free Credits:**
   - Continue consuming `free_credits_remaining` first
   - After free credits exhausted, use `credits_balance`
   - Maintain backward compatibility

### Backward Compatibility

- **Free Tier:** Unchanged (quota-based)
- **Free Credits:** Still consumed first (if plan has `free_credits`)
- **Bills Table:** Preserved for historical records
- **API:** New endpoints for credit purchase, existing endpoints unchanged

---

## Risk Assessment

### High Risk

1. **Race Conditions:**
   - **Mitigation:** Queue-based sequential processing eliminates race conditions

2. **Lost Credits:**
   - **Mitigation:** SQS guarantees at-least-once delivery, transaction logging for audit

3. **Double-Charging:**
   - **Mitigation:** 
     - FIFO queue deduplication (MessageDeduplicationId = job_id)
     - Idempotency check in processor (query CreditTransactions by job_id before deducting)
     - Transaction logging with job_id for audit trail
     - Sequential processing per user (MessageGroupId = user_id)

### Medium Risk

1. **Queue Backlog:**
   - **Mitigation:** Monitor queue depth, scale processor Lambda if needed

2. **Failed Deductions:**
   - **Mitigation:** Dead-letter queue, manual review process
   - **Note:** No refund mechanism needed - if deduction fails after PDF generation, PDF is lost but customer not charged (acceptable trade-off)

3. **Payment Processor Integration:**
   - **Mitigation:** Use established provider (Stripe, Paddle), handle webhooks reliably

### Low Risk

1. **Performance Degradation:**
   - **Mitigation:** Queue absorbs spikes, horizontal scaling

2. **Data Migration:**
   - **Mitigation:** Gradual rollout, comprehensive testing

---

## Monitoring & Alerts

### Key Metrics

1. **Credit Deduction Queue:**
   - Queue depth (messages waiting)
   - Processing rate (messages/second)
   - Failed messages (dead-letter queue)

2. **Credit Transactions:**
   - Deduction success rate
   - Average processing time
   - Failed deductions count

3. **User Credits:**
   - Users with zero balance
   - Average credit balance
   - Credit purchase rate

### Alerts

1. **Queue Depth > 1000:** Indicates processing bottleneck
2. **Failed Deductions > 10/hour:** Indicates system issue (investigate, but no customer impact - PDFs lost but not charged)
3. **Credit Balance Negative:** Indicates race condition (should never happen with FIFO queue)
4. **Processor Lambda Errors > 5%:** Indicates code issue
5. **Duplicate Transaction Attempts:** Monitor for duplicate job_id processing attempts (should be rare with FIFO deduplication)

---

## Cost Analysis

### Infrastructure Costs

**SQS FIFO Queue:**
- $0.50 per million requests (first 1M free)
- Estimated: ~$0.10/month for 200K transactions

**Credit Deduction Processor Lambda:**
- Pay-per-use (same as existing Lambdas)
- Estimated: ~$0.05/month for 200K transactions

**DynamoDB:**
- Additional writes for `CreditTransactions` table
- Estimated: ~$0.20/month for 200K transactions

**Total Additional Cost:** ~$0.35/month (negligible)

---

## Conclusion

**Recommended Solution: Queue-Based Credit Deduction (Option 3)**

This approach provides:
- ✅ **Reliability:** No race conditions, no double-charging (FIFO deduplication + idempotency)
- ✅ **Never Overcharge:** Credits deducted only after PDF success + idempotency prevents duplicates
- ✅ **Scalability:** Handles 10,000+ concurrent operations
- ✅ **Performance:** Fast credit check, async deduction
- ✅ **Cost-Effective:** Minimal additional infrastructure
- ✅ **Serverless-Friendly:** Fits existing architecture
- ✅ **Acceptable Trade-offs:** PDFs may be lost if deduction fails, but customers never overcharged

The queue-based approach with FIFO deduplication is the most suitable for handling high concurrency while guaranteeing customers are never overcharged, even if some PDFs are lost in edge cases.

---

**Document Version:** 1.0.0  
**Last Updated:** December 2025  
**Status:** Ready for Review

