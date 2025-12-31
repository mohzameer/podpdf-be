# PodPDF Multiple Webhooks Specification - Phase 1

**Version:** 1.0.0 (Phase 1)  
**Date:** December 24, 2025  
**Status:** Phase 1 - Basic Implementation

**Note:** This document covers Phase 1 implementation. For future enhancements, see `SPEC_WEBHOOKS_PHASE2.md`.

---

## Table of Contents

1. [Overview](#overview)
2. [Data Model](#data-model)
3. [Webhook Event Types](#webhook-event-types)
4. [Webhook Management API](#webhook-management-api)
5. [Webhook Delivery](#webhook-delivery)
6. [Webhook History](#webhook-history)

---

## Overview

Phase 1 of the Multiple Webhooks system provides:

- **Multiple webhook URLs per user** - Users can configure multiple webhook endpoints
- **Event-based filtering** - Each webhook can subscribe to specific event types
- **Webhook management** - Full CRUD operations for webhook configurations
- **Delivery tracking** - Basic history and status tracking for each webhook delivery
- **Simple validation** - Basic validation on webhook receiving endpoint

### Key Features

- **Flexibility**: Different webhooks for different purposes (production, staging, monitoring)
- **Reliability**: Multiple webhooks provide redundancy
- **Selective notifications**: Subscribe only to events you care about
- **Observability**: Basic delivery history and status tracking

### Architecture Flow

```
Job Completion Event
    ↓
Event Router (determines which webhooks to notify)
    ↓
Webhook Delivery Service (for each subscribed webhook)
    ↓
HTTP POST with retry logic
    ↓
Webhook History Record (success/failure tracking)
```

---

## Data Model

### Webhooks Table

**Purpose:** Store webhook configurations for each user

**Table Name:** `Webhooks`

**Partition Key:** `webhook_id` (String, ULID) - Unique identifier for each webhook

**Global Secondary Indexes:**
- `UserIdIndex` on `user_id` (for listing all webhooks for a user)
- `UserIdStatusIndex` on `user_id` and `is_active` (for filtering active webhooks)

**Attributes:**
- `webhook_id` (String, ULID) - Primary identifier (partition key)
- `user_id` (String, ULID) - User identifier (reference to Users table)
- `name` (String, optional) - User-provided name/description (e.g., "Production Webhook", "Staging Webhook")
- `url` (String, required) - HTTPS URL for webhook endpoint
- `events` (Array of Strings, required) - List of event types this webhook subscribes to
  - Valid values: `job.completed`, `job.failed`, `job.timeout`, `job.queued`, `job.processing`
  - Default: `["job.completed"]` if not specified
- `is_active` (Boolean) - Whether webhook is active (`true`) or disabled (`false`)
  - Default: `true`
  - Inactive webhooks are not called
- `created_at` (String, ISO 8601 timestamp) - When webhook was created
- `updated_at` (String, ISO 8601 timestamp) - Last update timestamp
- `last_triggered_at` (String, ISO 8601 timestamp, optional) - Last time webhook was called
- `success_count` (Number) - Total successful deliveries (counter, default: 0)
- `failure_count` (Number) - Total failed deliveries (counter, default: 0)
- `last_success_at` (String, ISO 8601 timestamp, optional) - Last successful delivery
- `last_failure_at` (String, ISO 8601 timestamp, optional) - Last failed delivery

**TTL:** Not applicable (permanent storage)

**Constraints:**
- Maximum webhooks per user is defined in the `Plans` table (`max_webhooks` field)
  - Free tier plans: 1 webhook
  - Paid tier plans: 5 webhooks
  - Enterprise tier plans: 50 webhooks
- URL must be HTTPS
- URL length: 1-2048 characters

### WebhookHistory Table

**Purpose:** Track delivery history for each webhook call

**Table Name:** `WebhookHistory`

**Partition Key:** `webhook_id` (String, ULID) - Reference to Webhooks table

**Sort Key:** `delivery_id` (String, ULID) - Unique identifier for each delivery attempt

**Global Secondary Indexes:**
- `JobIdIndex` on `job_id` (for finding all webhook deliveries for a job)
- `UserIdTimestampIndex` on `user_id` and `delivered_at` (for user's webhook history)

**Attributes:**
- `webhook_id` (String, ULID) - Reference to Webhooks table (partition key)
- `delivery_id` (String, ULID) - Unique delivery identifier (sort key)
- `user_id` (String, ULID) - User identifier (for quick lookups)
- `job_id` (String, UUID) - Job identifier that triggered this webhook
- `event_type` (String) - Event type that triggered webhook (e.g., `"job.completed"`)
- `url` (String) - Webhook URL (snapshot at time of delivery)
- `status` (String) - Delivery status: `"success"`, `"failed"`, `"timeout"`
- `status_code` (Number, optional) - HTTP status code from webhook endpoint
- `error_message` (String, optional) - Error message if delivery failed
- `retry_count` (Number) - Number of retry attempts (0-3)
- `delivered_at` (String, ISO 8601 timestamp) - When delivery completed (success or final failure)
- `duration_ms` (Number) - Total delivery duration in milliseconds
- `payload_size_bytes` (Number) - Size of webhook payload in bytes

**TTL:** 90 days (automatic cleanup of old history records)

**Note:** History records are created for each webhook delivery attempt, including retries.

### Updated JobDetails Table

**New Fields:**
- `webhook_ids` (Array of Strings, optional) - List of webhook IDs that were called for this job
  - Only populated for long jobs
  - Helps track which webhooks were notified for each job

**Existing Fields (unchanged):**
- `webhook_url` (String, optional) - Legacy field, kept for backward compatibility
- `webhook_delivered` (Boolean, optional) - Whether at least one webhook was successfully delivered
- `webhook_delivered_at` (String, optional) - Timestamp when first webhook was successfully delivered
- `webhook_retry_count` (Number, optional) - Maximum retry count across all webhooks

### Updated Plans Table

**New Field:**
- `max_webhooks` (Number, optional) - Maximum number of webhooks allowed for this plan
  - Default behavior: If not specified, defaults to `1` for free plans, `5` for paid plans
  - Can be customized per plan (e.g., `"free-basic"`: 1, `"paid-standard"`: 5, `"paid-enterprise"`: 50)
  - Used to enforce webhook limits when creating webhooks

**Example Plan Records:**
```json
{
  "plan_id": "free-basic",
  "name": "Free Basic",
  "type": "free",
  "max_webhooks": 1,
  ...
}
```

```json
{
  "plan_id": "paid-standard",
  "name": "Paid Standard",
  "type": "paid",
  "max_webhooks": 5,
  ...
}
```

```json
{
  "plan_id": "paid-enterprise",
  "name": "Paid Enterprise",
  "type": "paid",
  "max_webhooks": 50,
  ...
}
```

---

## Webhook Event Types

### Event Type: `job.completed`

**Triggered when:** A long job successfully completes PDF generation

**Payload:**
```json
{
  "event": "job.completed",
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "completed",
  "job_type": "long",
  "mode": "html",
  "pages": 150,
  "truncated": false,
  "s3_url": "https://s3.amazonaws.com/podpdf-dev-pdfs/9f0a4b78-2c0c-4d14-9b8b-123456789abc.pdf?X-Amz-Signature=...",
  "s3_url_expires_at": "2025-12-21T11:32:15Z",
  "created_at": "2025-12-21T10:30:00Z",
  "completed_at": "2025-12-21T10:32:15Z",
  "timestamp": "2025-12-21T10:32:15Z"
}
```

### Event Type: `job.failed`

**Triggered when:** A job fails during processing (PDF generation error, Chromium crash, etc.)

**Payload:**
```json
{
  "event": "job.failed",
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "failed",
  "job_type": "long",
  "mode": "html",
  "error_message": "PDF generation failed: Chromium process crashed",
  "created_at": "2025-12-21T10:30:00Z",
  "failed_at": "2025-12-21T10:32:15Z",
  "timestamp": "2025-12-21T10:32:15Z"
}
```

### Event Type: `job.timeout`

**Triggered when:** A quick job exceeds 30-second timeout

**Payload:**
```json
{
  "event": "job.timeout",
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "timeout",
  "job_type": "quick",
  "mode": "html",
  "timeout_seconds": 30,
  "created_at": "2025-12-21T10:30:00Z",
  "timeout_at": "2025-12-21T10:30:30Z",
  "timestamp": "2025-12-21T10:30:30Z"
}
```

### Event Type: `job.queued`

**Triggered when:** A long job is queued for processing

**Payload:**
```json
{
  "event": "job.queued",
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "queued",
  "job_type": "long",
  "mode": "html",
  "created_at": "2025-12-21T10:30:00Z",
  "timestamp": "2025-12-21T10:30:00Z"
}
```

### Event Type: `job.processing`

**Triggered when:** A long job starts processing (extracted from SQS queue)

**Payload:**
```json
{
  "event": "job.processing",
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "processing",
  "job_type": "long",
  "mode": "html",
  "created_at": "2025-12-21T10:30:00Z",
  "started_at": "2025-12-21T10:30:05Z",
  "timestamp": "2025-12-21T10:30:05Z"
}
```

### Common Payload Fields

All webhook payloads include:
- `event` (string) - Event type identifier
- `job_id` (string, UUID) - Job identifier
- `status` (string) - Current job status
- `job_type` (string) - `"quick"` or `"long"`
- `mode` (string) - `"html"`, `"markdown"`, or `"image"`
- `timestamp` (string, ISO 8601) - When the event occurred
- `created_at` (string, ISO 8601) - When the job was created

### Webhook Headers

All webhook requests include standard headers:
- `Content-Type: application/json`
- `User-Agent: PodPDF-Webhook/1.0`
- `X-Webhook-Event: <event_type>` (e.g., `X-Webhook-Event: job.completed`)
- `X-Webhook-Id: <webhook_id>` - Webhook identifier
- `X-Webhook-Delivery-Id: <delivery_id>` - Unique delivery identifier
- `X-Webhook-Timestamp: <iso_timestamp>` - Event timestamp

---

## Webhook Management API

### 1. POST /accounts/me/webhooks

**Description:** Create a new webhook configuration

**Authentication:** JWT Bearer Token required

**Plan-Based Limits:**
- Maximum webhooks per user is defined in the `Plans` table (`max_webhooks` field)
- If limit is reached, returns `403 Forbidden` with `WEBHOOK_LIMIT_EXCEEDED` error

**Request Body:**
```json
{
  "name": "Production Webhook",
  "url": "https://api.example.com/webhooks/podpdf",
  "events": ["job.completed", "job.failed"],
  "is_active": true
}
```

**Fields:**
- `name` (string, optional) - Descriptive name for the webhook
- `url` (string, required) - HTTPS URL for webhook endpoint
- `events` (array of strings, optional) - Event types to subscribe to
  - Default: `["job.completed"]` if not specified
  - Valid values: `job.completed`, `job.failed`, `job.timeout`, `job.queued`, `job.processing`
- `is_active` (boolean, optional) - Whether webhook is active (default: `true`)

**Response (201 Created):**
```json
{
  "webhook_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "user_id": "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "name": "Production Webhook",
  "url": "https://api.example.com/webhooks/podpdf",
  "events": ["job.completed", "job.failed"],
  "is_active": true,
  "created_at": "2025-12-24T10:00:00Z",
  "success_count": 0,
  "failure_count": 0
}
```

**Error Responses:**
- `400 Bad Request` - Invalid URL, invalid events, etc.
- `401 Unauthorized` - Missing or invalid JWT
- `403 Forbidden` - Account not found or webhook limit exceeded
  - Error code: `WEBHOOK_LIMIT_EXCEEDED`
  - Message includes current plan, current count, and max allowed from plan
- `500 Internal Server Error` - Server-side failure

**Webhook Limit Validation:**
- Before creating a webhook, system checks:
  1. User's plan from `Users` table (`plan_id`)
  2. Plan configuration from `Plans` table (`max_webhooks` field)
  3. Current webhook count for user (query `Webhooks` table using `UserIdIndex`)
  4. If current count >= plan's `max_webhooks`, reject with `403 WEBHOOK_LIMIT_EXCEEDED`

### 2. GET /accounts/me/webhooks

**Description:** List all webhooks for the authenticated user

**Authentication:** JWT Bearer Token required

**Query Parameters:**
- `is_active` (boolean, optional) - Filter by active status
- `event` (string, optional) - Filter webhooks that subscribe to this event type
- `limit` (number, optional) - Maximum results (default: 50, max: 100)
- `next_token` (string, optional) - Pagination token

**Response (200 OK):**
```json
{
  "webhooks": [
    {
      "webhook_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "name": "Production Webhook",
      "url": "https://api.example.com/webhooks/podpdf",
      "events": ["job.completed", "job.failed"],
      "is_active": true,
      "created_at": "2025-12-24T10:00:00Z",
      "updated_at": "2025-12-24T10:00:00Z",
      "last_triggered_at": "2025-12-24T15:30:00Z",
      "success_count": 150,
      "failure_count": 2,
      "last_success_at": "2025-12-24T15:30:00Z",
      "last_failure_at": "2025-12-24T14:20:00Z"
    }
  ],
  "count": 1,
  "next_token": null
}
```

**Error Responses:**
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Account not found
- `500 Internal Server Error` - Server-side failure

### 3. GET /accounts/me/webhooks/{webhook_id}

**Description:** Get details of a specific webhook

**Authentication:** JWT Bearer Token required

**Response (200 OK):**
```json
{
  "webhook": {
    "webhook_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "name": "Production Webhook",
    "url": "https://api.example.com/webhooks/podpdf",
    "events": ["job.completed", "job.failed"],
    "is_active": true,
    "created_at": "2025-12-24T10:00:00Z",
    "updated_at": "2025-12-24T10:00:00Z",
    "last_triggered_at": "2025-12-24T15:30:00Z",
    "success_count": 150,
    "failure_count": 2,
    "last_success_at": "2025-12-24T15:30:00Z",
    "last_failure_at": "2025-12-24T14:20:00Z"
  }
}
```

**Error Responses:**
- `401 Unauthorized` - Missing or invalid JWT
- `403 Forbidden` - Account not found or webhook doesn't belong to user
- `404 Not Found` - Webhook not found
- `500 Internal Server Error` - Server-side failure

### 4. PUT /accounts/me/webhooks/{webhook_id}

**Description:** Update an existing webhook configuration

**Authentication:** JWT Bearer Token required

**Request Body:**
```json
{
  "name": "Updated Production Webhook",
  "url": "https://api.example.com/webhooks/podpdf-v2",
  "events": ["job.completed"],
  "is_active": true
}
```

**Fields:** Same as POST, all optional (only provided fields are updated)

**Response (200 OK):**
```json
{
  "webhook_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "name": "Updated Production Webhook",
  "url": "https://api.example.com/webhooks/podpdf-v2",
  "events": ["job.completed"],
  "is_active": true,
  "updated_at": "2025-12-24T16:00:00Z"
}
```

**Error Responses:** Same as GET

### 5. DELETE /accounts/me/webhooks/{webhook_id}

**Description:** Delete a webhook configuration

**Authentication:** JWT Bearer Token required

**Response (204 No Content):**
- Empty body

**Error Responses:**
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Account not found or webhook does not belong to authenticated user
- `404 Not Found` - Webhook not found
- `500 Internal Server Error` - Server-side failure

### 6. GET /accounts/me/webhooks/{webhook_id}/history

**Description:** Get delivery history for a webhook

**Authentication:** JWT Bearer Token required

**Query Parameters:**
- `status` (string, optional) - Filter by delivery status (`success`, `failed`, `timeout`)
- `event_type` (string, optional) - Filter by event type
- `limit` (number, optional) - Maximum results (default: 50, max: 100)
- `next_token` (string, optional) - Pagination token

**Response (200 OK):**
```json
{
  "history": [
    {
      "delivery_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
      "event_type": "job.completed",
      "status": "success",
      "status_code": 200,
      "retry_count": 0,
      "delivered_at": "2025-12-24T15:30:00Z",
      "duration_ms": 245
    },
    {
      "delivery_id": "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      "job_id": "8e1b5c89-3d1d-5e25-ac9c-234567890def",
      "event_type": "job.completed",
      "status": "failed",
      "status_code": 500,
      "error_message": "HTTP 500",
      "retry_count": 3,
      "delivered_at": "2025-12-24T14:20:00Z",
      "duration_ms": 7500
    }
  ],
  "count": 2,
  "next_token": null
}
```

**Error Responses:**
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Account not found or webhook doesn't belong to user
- `404 Not Found` - Webhook not found
- `500 Internal Server Error` - Server-side failure

---

## Webhook Delivery

### Delivery Process

1. **Event Occurs**: Job status changes (completed, failed, timeout, etc.)

2. **Event Router**: Determines which webhooks should be notified
   - Filters webhooks by:
     - `is_active: true`
     - Event type subscription (`events` array contains the event type)
     - User ownership

3. **Webhook Delivery Service**: For each matching webhook:
   - Creates delivery record in WebhookHistory
   - Constructs payload based on event type
   - Adds standard headers
   - Sends HTTP POST request
   - Handles retries if delivery fails

4. **Retry Logic**:
   - System defaults: 3 retries with exponential backoff (1s, 2s, 4s)
   - Retries on:
     - Network errors
     - Timeout (10 seconds)
     - HTTP 5xx errors
     - HTTP 429 (Too Many Requests)
   - Does NOT retry on:
     - HTTP 2xx (success)
     - HTTP 4xx (client errors, except 429)

5. **History Recording**: Each delivery attempt (including retries) is recorded in WebhookHistory

6. **Status Updates**: Updates webhook statistics:
   - `last_triggered_at`
   - `success_count` or `failure_count`
   - `last_success_at` or `last_failure_at`

### Delivery Guarantees

- **At-least-once delivery**: Webhooks may be delivered multiple times in case of retries or system failures
- **Best-effort delivery**: Failed webhooks are retried, but if all retries fail, delivery is not guaranteed
- **Ordering**: Webhooks are delivered in the order events occur, but delivery order is not guaranteed across different webhooks
- **Idempotency**: Webhook receivers should handle duplicate deliveries (use `delivery_id` to deduplicate)

### Webhook Receiver Validation

**Basic Validation on Receiving Endpoint:**

Webhook receivers should perform basic validation:

1. **Validate Payload Structure**: Check that required fields are present and have correct types
2. **Validate Job ID**: Verify the `job_id` exists and belongs to your account (optional, can query PodPDF API)
3. **Idempotency Check**: Use `delivery_id` from `X-Webhook-Delivery-Id` header to prevent duplicate processing
4. **Fast Response**: Return `200 OK` quickly, process asynchronously if needed

**Example Validation (Node.js):**
```javascript
app.post('/webhooks/podpdf', async (req, res) => {
  // Basic payload validation
  const { event, job_id, status } = req.body;
  
  if (!event || !job_id || !status) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Get delivery ID for idempotency
  const deliveryId = req.headers['x-webhook-delivery-id'];
  
  // Check if already processed (use your database)
  if (await isAlreadyProcessed(deliveryId)) {
    return res.status(200).json({ message: 'Already processed' });
  }
  
  // Process webhook asynchronously
  processWebhookAsync(req.body, deliveryId);
  
  // Return success immediately
  return res.status(200).json({ message: 'Webhook received' });
});
```

---

## Webhook History

### History Tracking

Each webhook delivery is recorded in the `WebhookHistory` table with:
- Delivery status (success/failed/timeout)
- HTTP status code from receiver
- Error message (if failed)
- Retry count
- Delivery duration
- Payload size

### Statistics

Each webhook tracks:
- `success_count` - Total successful deliveries
- `failure_count` - Total failed deliveries
- `last_success_at` - Timestamp of last successful delivery
- `last_failure_at` - Timestamp of last failed delivery
- `last_triggered_at` - Last time webhook was called

### History Cleanup

- History records are automatically deleted after 90 days (TTL)
- Keeps database size manageable
- Users can query recent history via API

---

## Implementation Notes

### DynamoDB Table Creation

**Webhooks Table:**
```yaml
WebhooksTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: ${self:custom.stage}-webhooks
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: webhook_id
        AttributeType: S
      - AttributeName: user_id
        AttributeType: S
      - AttributeName: is_active
        AttributeType: S
    KeySchema:
      - AttributeName: webhook_id
        KeyType: HASH
    GlobalSecondaryIndexes:
      - IndexName: UserIdIndex
        KeySchema:
          - AttributeName: user_id
            KeyType: HASH
        Projection:
          ProjectionType: ALL
      - IndexName: UserIdStatusIndex
        KeySchema:
          - AttributeName: user_id
            KeyType: HASH
          - AttributeName: is_active
            KeyType: RANGE
        Projection:
          ProjectionType: ALL
```

**WebhookHistory Table:**
```yaml
WebhookHistoryTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: ${self:custom.stage}-webhook-history
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: webhook_id
        AttributeType: S
      - AttributeName: delivery_id
        AttributeType: S
      - AttributeName: job_id
        AttributeType: S
      - AttributeName: user_id
        AttributeType: S
      - AttributeName: delivered_at
        AttributeType: S
    KeySchema:
      - AttributeName: webhook_id
        KeyType: HASH
      - AttributeName: delivery_id
        KeyType: RANGE
    GlobalSecondaryIndexes:
      - IndexName: JobIdIndex
        KeySchema:
          - AttributeName: job_id
            KeyType: HASH
        Projection:
          ProjectionType: ALL
      - IndexName: UserIdTimestampIndex
        KeySchema:
          - AttributeName: user_id
            KeyType: HASH
          - AttributeName: delivered_at
            KeyType: RANGE
        Projection:
          ProjectionType: ALL
    TimeToLiveSpecification:
      AttributeName: ttl
      Enabled: true
```

### Lambda Functions

**New Functions:**
- `webhook-manager` - Handles webhook CRUD operations
- `webhook-delivery` - Handles webhook delivery (can be called from longjob-processor)

**Updated Functions:**
- `longjob-processor` - Updated to use new webhook system

### Environment Variables

```yaml
environment:
  WEBHOOKS_TABLE: ${self:custom.stage}-webhooks
  WEBHOOK_HISTORY_TABLE: ${self:custom.stage}-webhook-history
  DEFAULT_WEBHOOK_MAX_RETRIES: 3
  DEFAULT_WEBHOOK_RETRY_DELAYS: "1000,2000,4000"
  WEBHOOK_TIMEOUT_MS: 10000
```

**Note:** Webhook limits are stored in the `Plans` table (`max_webhooks` field), not in environment variables.

### Webhook Limit Enforcement

**Plans Table Update:**

Add new field to `Plans` table:
- `max_webhooks` (Number, optional) - Maximum number of webhooks allowed for this plan
  - Default: `1` for free plans, `5` for paid plans (if not specified)
  - Can be customized per plan (e.g., `"paid-standard"`: 5, `"paid-enterprise"`: 50)

**Implementation Logic:**
1. On webhook creation (`POST /accounts/me/webhooks`):
   - Retrieve user's plan from `Users` table (`plan_id`)
   - Look up plan configuration from `Plans` table
   - Get `max_webhooks` from plan (defaults to 1 for free, 5 for paid if not set)
   - Query `Webhooks` table using `UserIdIndex` to count existing webhooks
   - If current count >= plan's `max_webhooks`, reject with `403 WEBHOOK_LIMIT_EXCEEDED`
   - If within limit, create webhook

2. Error Response Format:
```json
{
  "error": {
    "code": "WEBHOOK_LIMIT_EXCEEDED",
    "message": "Webhook limit exceeded for your plan",
    "details": {
      "plan_id": "free-basic",
      "plan_type": "free",
      "current_count": 1,
      "max_allowed": 1,
      "upgrade_required": true
    }
  }
}
```

**Benefits of Plan-Based Limits:**
- Easy to adjust limits per plan without code changes
- Can create different paid plans with different webhook limits
- Centralized configuration in Plans table
- No environment variables needed for limits

---

## Summary

Phase 1 provides:

✅ **Plan-based webhook limits** (configured in Plans table: 1 for free tier, 5 for paid tier, 50 for enterprise tier)  
✅ **Event-based subscriptions** (filter which events each webhook receives)  
✅ **Comprehensive delivery tracking** (history, statistics)  
✅ **Full CRUD API** (create, read, update, delete webhooks)  
✅ **Basic validation** (payload structure, idempotency)  
✅ **Retry logic** (system defaults: 3 retries with exponential backoff)  
✅ **History tracking** (90-day retention with automatic cleanup)

For future enhancements (signing secrets, migration, advanced features), see `SPEC_WEBHOOKS_PHASE2.md`.

---

**Document Version:** 1.0.0 (Phase 1)  
**Last Updated:** December 24, 2025
