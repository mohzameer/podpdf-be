# PodPDF API Specification

**Version:** 2.0.0 (QuickJob and LongJob Architecture)  
**Date:** December 21, 2025  
**Architecture Style:** Fully Serverless on AWS

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Architecture](#architecture)
3. [AWS Services](#aws-services)
4. [Data Flow](#data-flow)
5. [API Specification](#api-specification)
6. [Input Support](#input-support)
7. [Security & Abuse Protection](#security--abuse-protection)
8. [Pricing Enforcement](#pricing-enforcement)
9. [Cost Profile](#cost-profile)
10. [Technical Constraints](#technical-constraints)

---

## High-Level Overview

PodPDF is a high-performance, ultra-low-cost PDF generation service that converts HTML or Markdown content into professional PDFs using headless Chromium (Puppeteer).

The service provides two specialized endpoints optimized for different use cases:

- **`POST /quickjob`** - Synchronous PDF generation for small documents that complete in under 30 seconds. Returns PDF binary directly in HTTP response.
- **`POST /longjob`** - Asynchronous PDF generation with queueing, S3 storage, and webhook notifications for larger or more complex documents.

**Key Features:**
- **QuickJob:** Instant response for small PDFs (invoices, receipts, simple reports)
- **LongJob:** Queue-based processing for large documents with webhook callbacks
- **Hard limit:** 100 pages per document (applies to both job types)
- **Webhook notifications:** Per-user webhook URLs with retry logic
- **S3 storage:** Generated PDFs stored with 1-hour signed URLs

This design prioritizes:
- **Developer experience** (instant response for quick jobs, async processing for long jobs)
- **Operational simplicity** (serverless, fully managed)
- **Cost optimization** (pay-per-use, no idle costs)

---

## Architecture

### Infrastructure as Code

- **Deployment Framework:** Serverless Framework 3.x or higher
- **Configuration:** All AWS resources defined in `serverless.yml`
- **Environment Management:** Separate stacks for development and production environments

### Core Principles

1. **Dual-Endpoint Design**: QuickJob for fast synchronous processing, LongJob for async queue-based processing
2. **Serverless-First**: Zero idle costs, pure pay-per-use model
3. **Queue-Based Processing**: SQS queue for reliable long job processing
4. **S3 Storage**: Temporary storage for long job PDFs with signed URLs
5. **Webhook Notifications**: Per-user webhook URLs with retry logic

### System Components

**QuickJob Flow:**
```
Client → API Gateway → Lambda (quickjob) → PDF (in-memory) → Direct Response
```

**LongJob Flow:**
```
Client → API Gateway → Lambda (longjob) → SQS Queue
                                              ↓
                                    Lambda (processor) → PDF → S3 → Webhook Callback
```

---

## AWS Services

### Amazon API Gateway

**Purpose:** Secure public HTTPS endpoint

**Configuration:**
- **Type:** HTTP API (v2) – cost-effective and low-latency
- **Response Encoding:** API Gateway is configured with `application/pdf` as a binary media type for QuickJob responses
- **CORS:** Enabled
- **Throttling:** 
  - Global: 1000 requests/second with 2000 burst
- **Authorization:** 
  - `/quickjob` and `/longjob`: No API Gateway authorizer (authentication handled in Lambda to support both JWT and API key)
  - Other authenticated endpoints: JWT authorizer integrated with Amazon Cognito
- **CloudWatch Logs:** Enabled for API Gateway access logging

### AWS Lambda

**Purpose:** Core application logic and PDF rendering

**Functions:**

1. **quickjob** - Synchronous PDF generation
   - **Runtime:** Node.js 20.x
   - **Memory:** 10,240 MB (maximum for fastest CPU)
   - **Timeout:** 30 seconds (hard limit for quick jobs)
   - **Layer:** `@sparticuz/chromium` (optimized headless Chromium binary for Lambda)
   - **Markdown Processing:** Lightweight library (marked or markdown-it)

2. **longjob** - Queue job submission
   - **Runtime:** Node.js 20.x
   - **Memory:** 1024 MB (minimal, just queues messages)
   - **Timeout:** 30 seconds
   - **Purpose:** Validates request and queues job to SQS

3. **longjob-processor** - Process queued jobs
   - **Runtime:** Node.js 20.x
   - **Memory:** 10,240 MB (maximum for fastest CPU)
   - **Timeout:** 900 seconds (15 minutes)
   - **Trigger:** SQS queue
   - **Layer:** `@sparticuz/chromium`
   - **Purpose:** Processes queued jobs, generates PDF, uploads to S3, calls webhook

### Amazon Cognito

**Purpose:** User authentication, sign-up/sign-in

**Configuration:**
- **User Pool:** Email-based sign-up
- **App Client:** JWT issuance
- **Note:** Plan information is stored in DynamoDB `Users` table, not in Cognito

### Amazon DynamoDB

**Purpose:** Usage tracking, rate limiting, quota enforcement, job tracking, and analytics

**Tables:**

1. **Users**
   - **Partition Key:** `user_id` (ULID - Universally Unique Lexicographically Sortable Identifier)
   - **Global Secondary Index:** `UserSubIndex` on `user_sub` (for lookups by Cognito user_sub)
   - **Attributes:** 
     - `user_id` (String, ULID) - Primary identifier for the user (e.g., `"01ARZ3NDEKTSV4RRFFQ69G5FAV"`)
     - `user_sub` (String) - User identifier from Cognito (for authentication lookups)
     - `email` (String) - User's email address (from Cognito)
     - `display_name` (String, optional) - User's display name
     - `plan_id` (String) - ID of the plan this user is on (e.g., `"free-basic"`, `"paid-standard"`)
     - `account_status` (String) - `"free"`, `"paid"`, or `"cancelled"` (defaults to `"free"` on account creation)
     - `total_pdf_count` (Number) - All-time PDF count for the user
     - `free_credits_remaining` (Number, optional) - Remaining free PDF credits for this user. Decremented when free credits are used. Can go negative (e.g., `-1`, `-2`) due to concurrent requests. Defaults to `null` if plan has no free credits. Initialized from `plan.free_credits` when user upgrades to a plan with free credits.
     - `quota_exceeded` (Boolean) - `true` if free tier user has exceeded their plan's quota limit (from `plan.monthly_quota`), `false` otherwise (defaults to `false`)
     - `webhook_url` (String, optional) - User's default webhook URL for long job notifications
     - `created_at` (String, ISO 8601 timestamp) - Account creation timestamp
     - `upgraded_at` (String, ISO 8601 timestamp, optional) - Timestamp when user upgraded to paid plan
   - **TTL:** Not applicable (permanent storage for user records)

2. **UserRateLimits**
   - **Partition Key:** `user_id` (String, ULID) - User identifier (reference to Users table)
   - **Sort Key:** `minute_timestamp` (format: YYYY-MM-DD-HH-MM)
   - **Attributes:**
     - `user_id` (String, ULID) - User identifier (partition key)
     - `minute_timestamp` (String) - Timestamp in format YYYY-MM-DD-HH-MM (sort key)
     - `request_count` (Number, atomic counter) - Number of requests in this minute window
     - `ttl` (Number, expires after 1 hour) - Time-to-live for automatic cleanup
   - **Note:** `user_id` is used as partition key for consistency across all tables. We already have `user_id` after the user account lookup (required for quota checks, billing, etc.), so using `user_id` for rate limiting doesn't add any extra lookups and maintains consistency.

3. **JobDetails**
   - **Partition Key:** `job_id` (UUID, generated per PDF generation request)
   - **Attributes:**
     - `user_id` (String, ULID) - User identifier (reference to Users table)
     - `api_key_id` (String, ULID, optional) - API key identifier (reference to ApiKeys table) - `null` if JWT was used for authentication
     - `status` (String) - Job status: `"queued"`, `"processing"`, `"completed"`, `"failed"`, or `"timeout"` (for quick jobs)
     - `job_type` (String, **required**) - `"quick"` or `"long"` - Distinguishes between synchronous quick jobs and asynchronous long jobs
     - `mode` (String) - Input mode: `"html"` or `"markdown"`
     - `pages` (Number) - Number of pages in the returned PDF (after any truncation)
     - `truncated` (Boolean) - `true` if the PDF was truncated to 100 pages, `false` otherwise
     - `created_at` (String, ISO 8601 timestamp) - Job creation timestamp
     - `completed_at` (String, ISO 8601 timestamp, optional) - Job completion timestamp
     - `error_message` (String, optional) - Error message if status is `"failure"` or `"timeout"`
     - `s3_key` (String, optional) - S3 object key for long jobs (only for long jobs)
     - `s3_url` (String, optional) - Signed URL for S3 object (1-hour expiry, only for long jobs)
     - `s3_url_expires_at` (String, optional) - ISO 8601 timestamp when signed URL expires (only for long jobs)
     - `webhook_url` (String, optional) - Webhook URL used for this job (user default or override, only for long jobs)
     - `webhook_delivered` (Boolean, optional) - Whether webhook was successfully delivered
     - `webhook_delivered_at` (String, optional) - ISO 8601 timestamp when webhook was delivered
     - `webhook_retry_count` (Number, optional) - Number of webhook retry attempts (0-3)
     - `webhook_retry_log` (Array, optional) - Array of webhook retry attempt timestamps and results
     - `timeout_occurred` (Boolean, optional) - `true` if quick job exceeded 30-second timeout
   - **TTL:** Not applicable (permanent storage for job history)
   - **Field Usage Notes:**
     - `job_type`: Set at job creation - `"quick"` for `/quickjob` endpoint, `"long"` for `/longjob` endpoint
     - `api_key_id`: Set at job creation - ULID of the API key used, or `null` if JWT authentication was used
     - `webhook_url`: Set at job creation for long jobs only - uses user's default webhook URL or override from request
     - `status`: Initial value is `"queued"` for long jobs, `"processing"` for quick jobs (immediate processing)
     - Long job fields (`s3_key`, `s3_url`, `webhook_url`, etc.) are only populated for `job_type: "long"`

4. **Analytics**
   - **Partition Key:** `job_id` (UUID, same as JobDetails for correlation)
   - **Attributes:**
     - `country` (String) - Country code (derived from request IP or user location)
     - `job_duration` (Number) - Job execution duration in milliseconds
     - `job_type` (String) - `"quick"` or `"long"`
     - `mode` (String) - Input mode: `"html"` or `"markdown"`
     - `pages` (Number) - Number of pages in the generated PDF
     - `status` (String) - Job status: `"success"`, `"failure"`, `"timeout"`, or `"queued"` (for long jobs)
     - `timeout_occurred` (Boolean, optional) - `true` if quick job exceeded 30-second timeout
     - `webhook_retry_count` (Number, optional) - Number of webhook retry attempts for long jobs
     - `created_at` (String, ISO 8601 timestamp) - Job creation timestamp
   - **Note:** No user information stored (privacy-focused analytics)
   - **TTL:** Not applicable (long-term analytics storage)

5. **Plans**
   - **Partition Key:** `plan_id` (String) - Unique identifier for the plan (e.g., `"free-basic"`, `"paid-standard"`)
   - **Attributes:**
     - `name` (String) - Human-readable plan name (e.g., `"Free Basic"`, `"Paid Standard"`)
     - `type` (String) - `"free"` or `"paid"`
     - `monthly_quota` (Number, optional) - Number of PDFs included per month (e.g., `100` for free, `null` for unlimited paid)
     - `free_credits` (Number, optional) - Number of free PDF credits included with the plan (e.g., `100`). These credits are used before `price_per_pdf` billing starts. Defaults to `0` if not set.
     - `price_per_pdf` (Number) - Price per PDF (e.g., `0` for free, `0.01` for paid)
     - `rate_limit_per_minute` (Number, optional) - Per-user rate limit (e.g., `20` for free, `null` or higher value for paid)
     - `description` (String, optional) - Description of the plan
     - `is_active` (Boolean) - Indicates if plan is active and available for assignment
   - **TTL:** Not applicable (plan configurations are long-lived)

6. **ApiKeys**
   - **Partition Key:** `api_key` (String) - The API key itself (e.g., `"pk_live_abc123..."` or `"pk_test_xyz789..."`)
   - **Global Secondary Indexes:**
     - `UserIdIndex` on `user_id` (for listing all API keys for a user)
     - `ApiKeyIdIndex` on `api_key_id` (for lookup by API key ID, used in revoke endpoint and job tracking)
   - **Attributes:**
     - `api_key` (String) - The API key (partition key, also stored as attribute for consistency)
     - `api_key_id` (String, ULID) - Unique identifier for the API key, used for references (e.g., in job records)
     - `user_id` (String, ULID) - User identifier (reference to Users table, used for rate limiting and quota checks)
     - `user_sub` (String) - Cognito user identifier (stored for reference, but not used for rate limiting)
     - `name` (String, optional) - User-provided name/description for the API key (e.g., `"Production API Key"`, `"Development Key"`)
     - `is_active` (Boolean) - Whether the API key is active and can be used (`false` if revoked)
     - `created_at` (String, ISO 8601 timestamp) - When the API key was created
     - `last_used_at` (String, ISO 8601 timestamp, optional) - Last time the API key was used
     - `revoked_at` (String, ISO 8601 timestamp, optional) - When the API key was revoked (if revoked)
   - **TTL:** Not applicable (API keys are long-lived until revoked)
   - **Note:** API keys are stored in plaintext as the partition key for fast lookups. The key format should be prefixed (e.g., `pk_live_` or `pk_test_`) for identification. `user_id` is used for rate limiting and quota checks for consistency across all tables. `api_key_id` is a ULID used to reference API keys in job records for auditing which API key was used for each job.

7. **Bills**
   - **Partition Key:** `user_id` (String, ULID) - User identifier
   - **Sort Key:** `billing_month` (String) - Billing month in `YYYY-MM` format (e.g., `"2025-12"`)
   - **Attributes:**
     - `user_id` (String, ULID) - User identifier (partition key)
     - `billing_month` (String) - Billing month in `YYYY-MM` format (sort key)
     - `monthly_pdf_count` (Number) - Number of PDFs generated in this month
     - `monthly_billing_amount` (Number) - Total amount accumulated for this month in USD
     - `is_paid` (Boolean) - Whether the bill has been paid (defaults to `false`)
     - `bill_id` (String, optional) - External bill/invoice ID (for future integration with payment processors like Paddle)
     - `invoice_id` (String, optional) - Invoice ID from payment processor
     - `paddle_subscription_id` (String, optional) - Paddle subscription ID (for future integration)
     - `paddle_transaction_id` (String, optional) - Paddle transaction ID (for future integration)
     - `paid_at` (String, optional) - ISO 8601 timestamp when bill was marked as paid
     - `created_at` (String, ISO 8601 timestamp) - Bill record creation timestamp
     - `updated_at` (String, ISO 8601 timestamp) - Last update timestamp
   - **Global Secondary Index:** `UserIdBillingMonthIndex` on `user_id` and `billing_month` (for lookups by user_id)
   - **TTL:** Not applicable (bills are permanent records for invoicing and accounting)

### Amazon S3

**Purpose:** Store generated PDFs for long jobs

**Configuration:**
- **Bucket Name:** `podpdf-{stage}-pdfs`
- **Access:** Private bucket (no public access)
- **Encryption:** Server-side encryption (SSE-S3)
- **Lifecycle Policy:** Delete objects after 24 hours
- **Signed URLs:** 1-hour expiry for secure access

### Amazon SQS

**Purpose:** Queue long job processing requests

**Configuration:**
- **Queue Name:** `podpdf-{stage}-longjob-queue`
- **Type:** Standard queue
- **Visibility Timeout:** 900 seconds (15 minutes)
- **Message Retention:** 14 days
- **Dead-Letter Queue:** Optional, for failed processing after max retries

**Deduplication Strategy:**
- Standard SQS queues provide at-least-once delivery (messages may be delivered multiple times)
- Deduplication is handled via DynamoDB `JobDetails` table:
  - Before processing a message, `longjob-processor` checks if job already exists in `JobDetails`
  - If job exists with status `"completed"` or `"processing"`, message is skipped (duplicate)
  - If job doesn't exist or status is `"queued"`, processing proceeds
  - Uses conditional updates to atomically transition status from `"queued"` to `"processing"` to prevent race conditions
  - This ensures idempotent processing even with duplicate SQS message deliveries

### Amazon CloudWatch

**Purpose:** Logging, metrics, and monitoring

**Configuration:**
- Standard Lambda logs and metrics
- Custom metrics:
  - Generation duration (by job type)
  - Success rate (by job type)
  - Timeout rate (quick jobs)
  - Webhook delivery success rate
  - Throttle events

### AWS Budgets & Billing

**Purpose:** Cost protection and early warnings

**Configuration:**
- Monthly budget alerts at low thresholds (e.g., $10, $50)
- Forecasted spend notifications

---

## Data Flow

### QuickJob Flow (Synchronous)

1. **Authentication**
   - Client authenticates via Cognito and receives a JWT token

2. **Request Submission**
   - Client sends `POST /quickjob` with:
     - **For HTML/Markdown:** JSON payload containing:
       - `input_type` (string, required): `"html"` or `"markdown"`
       - `html` (string): HTML content (required if `input_type` is `"html"`)
       - `markdown` (string): Markdown content (required if `input_type` is `"markdown"`)
       - `options` (object, optional): Rendering options
     - **For Images:** Multipart/form-data containing:
       - `input_type` (string, required): `"image"`
       - `images` (files, required): One or more PNG/JPEG image files
       - `options` (string, optional): JSON string with PDF options

3. **API Gateway Processing**
   - No authorizer configured for `/quickjob` (authentication handled in Lambda)
   - Applies global throttling
   - Routes request to Lambda function

4. **Lambda Handler Execution (quickjob)**
   
   **Authentication Phase:**
   - **JWT Token Path:**
     - Extracts JWT from `Authorization: Bearer <token>` header
     - Verifies JWT signature against Cognito JWKS (public keys)
     - Validates issuer, audience, expiration, and `token_use: id`
     - Extracts user ID (`sub`) from verified token claims
   - **API Key Path:**
     - Extracts API key from `X-API-Key` header or `Authorization: Bearer pk_...` header
     - Looks up API key in `ApiKeys` table (one DynamoDB lookup)
     - If found and `is_active: true`, retrieves `user_id` (and `user_sub` for user account lookup)
     - Updates `last_used_at` timestamp
     - If not found or inactive, rejects with 401 error
   - **Note:** API key takes precedence if both are provided
   
   **Validation Phase:**
   - Validates user account exists: Retrieves user record from DynamoDB `Users` table using `user_id`
   - If user record doesn't exist, rejects with 403 error
   - Reads user plan from DynamoDB
   - Validates request body (same validation as described in API Specification)
   - Enforces per-user rate limit for free tier users only (20 requests/minute)
     - Uses `user_id` for rate limit lookups (works for both JWT and API key)
     - Rate limit check is a direct DynamoDB lookup using `user_id` as partition key
     - `user_id` is already available from the user account lookup (required for quota checks, billing, etc.)
   - Checks all-time quota for free tier users (quota limit from `plan.monthly_quota` in `Plans` table)
   - Validates input size limits (~5 MB maximum)

   **Processing Phase (if checks pass):**
   - Generates unique `job_id` (UUID) for this request
   - Records job start time for duration tracking
   - Starts 30-second timeout timer
   - If `input_type` is `"markdown"`, converts Markdown to HTML
   - Launches headless Chromium (via layer)
   - Renders the final HTML content
   - Generates the PDF using Puppeteer `page.pdf()` with user-provided options
   - Checks page count: After PDF generation, counts actual pages
   - If PDF exceeds 100 pages, truncates to first 100 pages
   - **Timeout Check:** If processing exceeds 30 seconds:
     - Stops processing
     - Records job with `status: "timeout"`, `timeout_occurred: true`
     - Logs timeout in Analytics table
     - Returns 408 Request Timeout error
   - Records job completion (on both success and failure):
     - Writes to `JobDetails` table: user info, job status, mode, pages, `truncated` flag, timestamps, `job_type: "quick"`, error message (if failure), `timeout_occurred` (if timeout)
     - Writes to `Analytics` table: country, job duration, mode, pages, status, `job_type: "quick"`, `timeout_occurred` (if timeout)
   - On success: Returns the PDF binary directly in the response (truncated if necessary)
   - On failure: Returns appropriate error response

5. **Success Response**
   - **Status:** 200 OK
   - **Content-Type:** `application/pdf`
   - **Content-Disposition:** `inline; filename="document.pdf"`
   - **X-PDF-Pages:** Number of pages in the returned PDF
   - **X-PDF-Truncated:** `true` if PDF was truncated to 100 pages, `false` otherwise
   - **X-Job-Id:** Job ID (UUID)
   - **Body:** Raw PDF binary data (truncated to 100 pages maximum if original exceeded limit)

### LongJob Flow (Asynchronous)

1. **Authentication**
   - Client authenticates via Cognito and receives a JWT token

2. **Request Submission**
   - Client sends `POST /longjob` with JSON payload containing:
     - `input_type` (string, required): Either `"html"` or `"markdown"`
     - `html` (string, optional): HTML content (required if `input_type` is `"html"`)
     - `markdown` (string, optional): Markdown content (required if `input_type` is `"markdown"`)
     - `options` (object, optional): Rendering options
     - `webhook_url` (string, optional): Override user's default webhook URL for this job

3. **API Gateway Processing**
   - No authorizer configured for `/longjob` (authentication handled in Lambda)
   - Applies global throttling
   - Routes request to Lambda function

4. **Lambda Handler Execution (longjob)**
   
   **Authentication Phase:**
   - **JWT Token Path:**
     - Extracts JWT from `Authorization: Bearer <token>` header
     - Verifies JWT signature against Cognito JWKS (public keys)
     - Validates issuer, audience, expiration, and `token_use: id`
     - Extracts user ID (`sub`) from verified token claims
   - **API Key Path:**
     - Extracts API key from `X-API-Key` header or `Authorization: Bearer pk_...` header
     - Looks up API key in `ApiKeys` table (one DynamoDB lookup)
     - If found and `is_active: true`, retrieves `user_id` (and `user_sub` for user account lookup)
     - Updates `last_used_at` timestamp
     - If not found or inactive, rejects with 401 error
   - **Note:** API key takes precedence if both are provided
   
   **Validation Phase:**
   - Validates user account exists: Retrieves user record from DynamoDB `Users` table using `user_id`
   - If user record doesn't exist, rejects with 403 error
   - Reads user plan from DynamoDB
   - Validates request body (same validation as described in API Specification)
   - Enforces per-user rate limit for free tier users only (20 requests/minute)
     - Uses `user_id` for rate limit lookups (works for both JWT and API key)
     - Rate limit check is a direct DynamoDB lookup using `user_id` as partition key
     - `user_id` is already available from the user account lookup (required for quota checks, billing, etc.)
   - Checks all-time quota for free tier users (quota limit from `plan.monthly_quota` in `Plans` table)
   - Validates input size limits (~5 MB maximum)
   - If `webhook_url` provided, validates it's a valid HTTPS URL

   **Queueing Phase (if checks pass):**
   - Generates unique `job_id` (UUID) for this request
   - Retrieves user's default `webhook_url` from Users table (if not overridden in request)
   - Creates job record in DynamoDB `JobDetails` table with:
     - `status: "queued"`
     - `job_type: "long"`
     - `webhook_url` (user default or override)
     - All other job metadata
   - Sends message to SQS queue with:
     - `job_id`
     - `user_sub`
     - `input_type`, `html`/`markdown`, `options`
     - `webhook_url`
   - Returns 202 Accepted with job_id

5. **SQS Processing (longjob-processor)**
   - Lambda function triggered by SQS queue
   - **Deduplication Check:**
     - Reads job record from DynamoDB `JobDetails` table using `job_id` from SQS message
     - If job exists with status `"completed"` or `"processing"`, skips processing (duplicate message)
     - If job doesn't exist or status is `"queued"`, proceeds with processing
   - **Atomic Status Update:**
     - Uses conditional update to atomically change status from `"queued"` to `"processing"`
     - If update fails (status already changed), skips processing (another instance is handling it)
   - Extracts job details from SQS message
   - If `input_type` is `"markdown"`, converts Markdown to HTML
   - Launches headless Chromium
   - Renders the final HTML content
   - Generates the PDF using Puppeteer `page.pdf()`
   - Checks page count and truncates to 100 pages if needed
   - Uploads PDF to S3 with key: `{job_id}.pdf`
   - Generates 1-hour signed URL for S3 object
   - Updates job status to `"completed"` in DynamoDB with:
     - `s3_key`
     - `s3_url` (signed URL)
     - `s3_url_expires_at`
     - `pages`, `truncated` flag
     - `completed_at` timestamp
   - Records in Analytics table
   - **Webhook Delivery:**
     - If `webhook_url` is configured, calls webhook with job details
     - Retry logic: Up to 3 retries with exponential backoff (1s, 2s, 4s)
     - Logs each retry attempt in `webhook_retry_log` array
     - Updates `webhook_delivered`, `webhook_delivered_at`, `webhook_retry_count` in JobDetails
     - Logs webhook retry count in Analytics table
     - If all retries fail, marks job as completed but logs webhook failure

6. **Webhook Payload**
   - POST request to user's webhook URL with:
   ```json
   {
     "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
     "status": "completed",
     "s3_url": "https://s3.amazonaws.com/...?X-Amz-Signature=...",
     "s3_url_expires_at": "2025-12-21T11:32:15Z",
     "pages": 150,
     "mode": "html",
     "truncated": true,
     "created_at": "2025-12-21T10:30:00Z",
     "completed_at": "2025-12-21T10:32:15Z"
   }
   ```

---

## API Specification

### 1. POST /quickjob

**Description:** Synchronous PDF generation for small documents that complete in under 30 seconds.

**Authentication:** JWT Bearer Token required

**Request Body:**
```json
{
  "input_type": "html",
  "html": "<!DOCTYPE html><html><head><title>Document</title></head><body><h1>Hello World</h1></body></html>",
  "options": {
    "format": "A4",
    "margin": {
      "top": "20mm",
      "right": "20mm",
      "bottom": "20mm",
      "left": "20mm"
    },
    "printBackground": true,
    "scale": 1.0
  }
}
```

**Response (Success - 200 OK):**
- **Content-Type:** `application/pdf`
- **Content-Disposition:** `inline; filename="document.pdf"`
- **X-PDF-Pages:** Number of pages
- **X-PDF-Truncated:** `true` if truncated, `false` otherwise
- **X-Job-Id:** Job ID (UUID)
- **Body:** PDF binary data

**Response (Timeout - 408 Request Timeout):**
```json
{
  "error": {
    "code": "QUICKJOB_TIMEOUT",
    "message": "Job processing exceeded 30-second timeout. Please use /longjob endpoint for larger documents.",
    "details": {
      "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
      "timeout_seconds": 30,
      "suggestion": "use_longjob_endpoint"
    }
  }
}
```

**Error Responses:** Same as current `/generate` endpoint (400, 401, 403, 500)

### 2. POST /longjob

**Description:** Asynchronous PDF generation with queueing, S3 storage, and webhook notifications.

**Authentication:** JWT Bearer Token required

**Request Body:**
```json
{
  "input_type": "html",
  "html": "<!DOCTYPE html>...",
  "options": {
    "format": "A4",
    "margin": { "top": "20mm", "right": "20mm", "bottom": "20mm", "left": "20mm" },
    "printBackground": true,
    "scale": 1.0
  },
  "webhook_url": "https://example.com/webhook" // Optional: overrides user's default webhook
}
```

**Response (Success - 202 Accepted):**
```json
{
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "queued",
  "message": "Job queued for processing",
  "estimated_completion": "2025-12-21T10:35:00Z"
}
```

**Error Responses:** Same validation errors as `/quickjob` (400, 401, 403)

### 3. GET /jobs/{job_id}

**Description:** Get status and details of a specific job.

**Authentication:** JWT Bearer Token required

**Response (Success - 200 OK):**
```json
{
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "completed",
  "job_type": "long",
  "mode": "html",
  "pages": 150,
  "truncated": true,
  "created_at": "2025-12-21T10:30:00Z",
  "completed_at": "2025-12-21T10:32:15Z",
  "s3_url": "https://s3.amazonaws.com/...?X-Amz-Signature=...",
  "s3_url_expires_at": "2025-12-21T11:32:15Z",
  "webhook_delivered": true,
  "webhook_delivered_at": "2025-12-21T10:32:20Z",
  "webhook_retry_count": 0,
  "error_message": null
}
```

**Response (404 Not Found):**
- Job not found or doesn't belong to authenticated user

### 4. PUT /accounts/me/webhook

**Description:** Configure user's default webhook URL for long job notifications.

**Authentication:** JWT Bearer Token required

**Request Body:**
```json
{
  "webhook_url": "https://example.com/webhook"
}
```

**Response (Success - 200 OK):**
```json
{
  "user_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "webhook_url": "https://example.com/webhook",
  "updated_at": "2025-12-21T10:00:00Z"
}
```

**Validation:**
- `webhook_url` must be a valid HTTPS URL
- Returns 400 if URL is invalid or not HTTPS

### 5. GET /plans and GET /plans/{plan_id}

**Description:** Get plan details. Use `GET /plans` to list all active plans, or `GET /plans/{plan_id}` to get details for a specific plan.

**Authentication:** None (public endpoint)

**Response (List All Plans - 200 OK):**
```json
{
  "plans": [
    {
      "plan_id": "free-basic",
      "name": "Free Basic",
      "type": "free",
      "monthly_quota": 100,
      "price_per_pdf": 0,
      "rate_limit_per_minute": 20,
      "description": "Free tier with 100 PDFs all-time quota (not monthly - cumulative, does not reset). Rate limit: 20 requests per minute.",
      "is_active": true
    },
    {
      "plan_id": "paid-standard",
      "name": "Paid Standard",
      "type": "paid",
      "monthly_quota": null,
      "price_per_pdf": 0.01,
      "rate_limit_per_minute": null,
      "description": "Paid plan with unlimited PDFs. Price: $0.01 per PDF. Unlimited rate limit.",
      "is_active": true
    }
  ],
  "count": 2
}
```

**Response (Get Specific Plan - 200 OK):**
```json
{
  "plan": {
    "plan_id": "free-basic",
    "name": "Free Basic",
    "type": "free",
    "monthly_quota": 100,
    "price_per_pdf": 0,
    "rate_limit_per_minute": 20,
    "description": "Free tier with 100 PDFs all-time quota (not monthly - cumulative, does not reset). Rate limit: 20 requests per minute.",
    "is_active": true
  }
}
```

**Response (404 Not Found):**
- Plan not found (for specific plan endpoint)

**Plan Fields:**
- `plan_id` (string) - Unique plan identifier
- `name` (string) - Human-readable plan name
- `type` (string) - Plan type: `"free"` or `"paid"`
- `monthly_quota` (number|null) - Number of PDFs included per month for free plans, `null` for unlimited paid plans
- `price_per_pdf` (number) - Price per PDF in USD (0 for free plans)
- `rate_limit_per_minute` (number|null) - Per-user rate limit in requests per minute, `null` for unlimited
- `description` (string|null) - Plan description
- `is_active` (boolean) - Whether the plan is active and available

**Notes:**
- Public endpoint - no authentication required
- List endpoint only returns active plans (`is_active: true`)
- Plans are sorted by type (free first) then alphabetically by name

### Authentication Methods

The `/quickjob` and `/longjob` endpoints support two authentication methods:

1. **JWT Token (Bearer Token)**
   - **Header:** `Authorization: Bearer <jwt_token>`
   - Token must be the **ID token** (not access token) from Cognito sign-in
   - Token is verified directly in Lambda against Cognito JWKS (public keys)
   - Validates issuer, audience, expiration, algorithm (RS256), and `token_use: id`
   - User ID (`sub`) is extracted from verified token claims
   - No API Gateway authorizer is used (authentication handled in Lambda to support dual auth)

2. **API Key**
   - **Header:** `X-API-Key: <api_key>` or `Authorization: Bearer <api_key>`
   - API key is looked up in `ApiKeys` table
   - If found and active, `user_id` and `user_sub` are retrieved
   - If not found or revoked, returns 401 Unauthorized

**Authentication Requirements:**
- **One of the above methods must be present** (either JWT token OR API key)
- If both are provided, API key takes precedence
- If neither is provided, returns 401 Unauthorized

### Request Validation

All requests are validated in the following order:

1. **Authentication Validation:**
   - **JWT Token Path:**
     - JWT token must be present in `Authorization: Bearer <token>` header
     - Token is verified against Cognito JWKS (public keys) in Lambda
     - Validates issuer, audience, expiration, algorithm (RS256), and `token_use: id`
     - Returns 401 if token is missing, invalid, expired, or not an ID token
     - User ID (`sub`) is extracted from verified token claims
   - **API Key Path:**
     - API key must be present in `X-API-Key` header or `Authorization: Bearer pk_...` header
     - API key is looked up in `ApiKeys` table (one DynamoDB lookup)
     - If found and `is_active: true`, retrieves `user_id` and `user_sub`
     - If not found or `is_active: false`, returns 401 Unauthorized
     - Updates `last_used_at` timestamp on successful lookup
   - **Priority:** API key takes precedence if both are provided

2. **Account Validation:**
   - User account must exist in DynamoDB `Users` table
   - Lookup is done using `user_id` (from JWT `sub` via GSI, or directly from API key lookup)
   - If account doesn't exist, returns 403 error with `ACCOUNT_NOT_FOUND` code

3. **Request Body Validation:**
   - `input_type` field validation (400 if missing or invalid)
   - Content field validation (400 if missing, empty, or wrong field provided)
   - Content type validation (400 if content doesn't match declared type)
   - Input size validation (400 if exceeds ~5 MB limit)
   - Webhook URL validation (for longjob and webhook endpoint: must be HTTPS)

4. **Business Logic Validation:**
   - Per-user rate limit check (403 if free tier user exceeds 20 requests/minute)
   - Quota check for free tier users (403 if quota exceeded, upgrade required)
   - No quota check for paid plan users (unlimited)

**Validation Order:**
1. Authentication → 2. Account → 3. Request Body → 4. Business Logic

**Error Response Priority:**
- Authentication errors (401) are returned first
- Account errors (403) are returned after authentication
- Request body errors (400) are returned after account validation
- Business logic errors (403) are returned last

### Request Options

All options are passed directly to Puppeteer's `page.pdf()` method. Common options:

- `format`: Paper format (e.g., "A4", "Letter")
- `margin`: Object with top, right, bottom, left margins
- `printBackground`: Boolean (default: true)
- `scale`: Number (default: 1.0)
- `landscape`: Boolean (default: false)
- `preferCSSPageSize`: Boolean (default: false)

---

## API Key Management

### API Key Table Structure

The `ApiKeys` table stores API keys for programmatic access to `/quickjob` and `/longjob` endpoints.

**Key Design:**
- **Partition Key:** `api_key` (the API key itself, stored in plaintext for fast lookups)
- **No Sort Key:** Simple key-value lookup structure
- **Global Secondary Indexes:**
  - `UserIdIndex` on `user_id` (for listing all API keys for a user)
  - `ApiKeyIdIndex` on `api_key_id` (for lookup by API key ID)
- **Format:** API keys should be prefixed (e.g., `pk_live_...` or `pk_test_...`) for identification

**Attributes:**
- `api_key` (String) - The API key (partition key)
- `api_key_id` (String, ULID) - Unique identifier for the API key, used for references in job records
- `user_id` (String, ULID) - User identifier (reference to Users table)
- `user_sub` (String) - Cognito user identifier (for rate limiting - same `user_sub` used in UserRateLimitsTable)
- `name` (String, optional) - User-provided name/description (e.g., `"Production API Key"`, `"Development Key"`)
- `is_active` (Boolean) - Whether the API key is active (`false` if revoked)
- `created_at` (String, ISO 8601) - Creation timestamp
- `last_used_at` (String, ISO 8601, optional) - Last usage timestamp (updated on each successful authentication)
- `revoked_at` (String, ISO 8601, optional) - Revocation timestamp (set when key is revoked)

### API Key Usage

**Authentication:**
- API keys can be provided in two ways:
  1. `X-API-Key: <api_key>` header
  2. `Authorization: Bearer <api_key>` header (for compatibility with standard auth patterns)
- API key lookup is a single DynamoDB `GetItem` operation using the API key as partition key
- If found and `is_active: true`, the request proceeds with the associated `user_id` and `user_sub`
- If not found or `is_active: false`, returns 401 Unauthorized

**Rate Limiting:**
- Once `user_id` is retrieved from the user account lookup (after API key or JWT authentication), rate limiting uses `user_id` as partition key
- Rate limit records use `user_id` as partition key (same table: `UserRateLimitsTable`)
- Same per-minute window, atomic counters, and TTL-based cleanup
- **Performance:** 
  - **JWT Token:** User account lookup (1 DynamoDB lookup via GSI on `user_sub`) → Rate limit check using `user_id` (1 DynamoDB lookup) = 2 total lookups
  - **API Key:** API key lookup (1 DynamoDB lookup) → User account lookup using `user_id` (1 DynamoDB lookup) → Rate limit check using `user_id` (1 DynamoDB lookup) = 3 total lookups
- **Note:** We use `user_id` for rate limiting because we already have it after the user account lookup (required for quota checks, billing, etc.), maintaining consistency across all tables

**Multiple API Keys per User:**
- Users can create multiple API keys (e.g., one for production, one for development)
- Each API key is independent and can be revoked separately
- All API keys for a user share the same rate limits and quota (tied to `user_id`)

**Revocation:**
- API keys can be revoked by setting `is_active: false` and `revoked_at: <timestamp>`
- Revoked keys immediately fail authentication (401 Unauthorized)
- Revoked keys are not deleted (for audit trail) but are marked inactive

### API Key Management Endpoints (Future)

The following endpoints will be needed for API key management (to be implemented):

- `POST /accounts/me/api-keys` - Create a new API key
- `GET /accounts/me/api-keys` - List all API keys for the authenticated user
- `DELETE /accounts/me/api-keys/{api_key_id}` - Revoke an API key

**Note:** These endpoints will require JWT authentication (not API key authentication) to prevent API key self-revocation loops.

---

## Input Support

### HTML

- Full HTML documents supported
- **Best Practice:** Must include `<!DOCTYPE html>` for best results
- Supports all standard HTML5 elements
- External resources (images, stylesheets) loaded via URL

### Markdown

**Supported Features:**
- GitHub-flavored Markdown
- Headings (H1-H6)
- Lists (ordered and unordered)
- Tables
- Code blocks (with syntax highlighting)
- Links
- Bold/italic text
- Images via URL

**Conversion:**
- Markdown to HTML conversion happens instantly in-memory
- Zero additional cost for Markdown processing
- Uses lightweight library (marked or markdown-it)

### Images (PNG/JPEG)

**Overview:**
- Convert single or multiple images to PDF
- Each image becomes one page in the PDF
- Uses multipart/form-data for efficient binary uploads (no base64 overhead)
- Processed using Sharp + pdf-lib (fast, low memory, no Chromium needed)

**Supported Formats:**
- PNG (`.png`) - Portable Network Graphics
- JPEG/JPG (`.jpg`, `.jpeg`) - Joint Photographic Experts Group

**Request Format:**
- Content-Type: `multipart/form-data`
- Fields:
  - `input_type`: Must be `"image"`
  - `images`: One or more image files (can repeat field for multiple images)
  - `options`: JSON string with PDF options (optional)

**Image-Specific Options:**
- `fit`: How to fit image on page
  - `"contain"` (default): Fit whole image, maintain aspect ratio
  - `"cover"`: Fill entire page, may crop image
  - `"fill"`: Stretch image to fill page (may distort)
  - `"none"`: Use image's natural size

**Limits:**
- Maximum 5MB per image
- Maximum 10MB total payload
- Maximum 10000x10000 pixels per image
- Maximum 100 images per request (truncated, not rejected)

**Performance:**
- Single image: ~0.5-1 second (vs 2-3s for HTML)
- 10 images: ~2-4 seconds
- No Chromium cold start overhead
- ~60% lower Lambda cost than HTML/Markdown

---

## Security & Abuse Protection

### Authentication

- **Mandatory:** All requests to `/quickjob` and `/longjob` require either:
  - **JWT Token:** Valid Cognito JWT token in `Authorization: Bearer <token>` header
  - **API Key:** Valid API key in `X-API-Key: <key>` or `Authorization: Bearer <key>` header
- **One of the above must be present** (either JWT token OR API key)
- **No unauthenticated access** allowed

**Authentication Performance:**
- **JWT Token:** Lambda verifies token against Cognito JWKS (cached for 10 minutes), `user_sub` extracted from claims
- **API Key:** One DynamoDB lookup to `ApiKeys` table to retrieve `user_id` and `user_sub`

**JWT Verification Details:**
- JWKS (JSON Web Key Set) is fetched from Cognito and cached for 10 minutes
- Token signature is verified using RS256 algorithm
- Issuer must match `https://cognito-idp.{region}.amazonaws.com/{user_pool_id}`
- Audience must match the Cognito User Pool Client ID
- `token_use` claim must be `id` (not `access`)

### Throttling Layers

1. **Global Throttling (API Gateway)**
   - 1000 requests/second with 2000 burst capacity
   - Applied at the API Gateway level for all requests

2. **Per-User Rate Limiting (Lambda)**
   - Enforced in code using DynamoDB atomic counters
   - **Free Tier:** 20 requests/minute (enforced per user)
   - **Paid Tier:** Unlimited (only limited by API Gateway global throttling)
   - **Rate Limit Table:** `UserRateLimitsTable` with partition key `user_id`
   - **Performance:**
     - **JWT Token:** JWT verification (cached JWKS) → User account lookup via GSI on `user_sub` (1 DynamoDB lookup) → Rate limit check using `user_id` (1 DynamoDB lookup) = 2 DynamoDB lookups + JWT verification
     - **API Key:** API key lookup (1 DynamoDB lookup) → User account lookup using `user_id` (1 DynamoDB lookup) → Rate limit check using `user_id` (1 DynamoDB lookup) = 3 total lookups
   - **Note:** Rate limiting uses `user_id` as partition key for consistency across all tables. We already have `user_id` after the user account lookup (required for quota checks, billing, etc.), so using `user_id` doesn't add any extra lookups and maintains consistency.

### Content Limits

- **Page Limit:** 100 pages per document (hard limit, applies to both quick and long jobs)
  - Page count is determined after PDF rendering (not estimated)
  - If rendered PDF exceeds 100 pages, it is automatically truncated to the first 100 pages
  - Truncated PDFs are returned with `X-PDF-Truncated: true` header and `X-PDF-Pages: 100` header
  - This ensures accurate page counting based on actual rendered output
- **Input Size:** ~5 MB maximum
- **Enforcement:** Input size rejected with 400 error if exceeded; page limit enforced via truncation
- **QuickJob Timeout:** 30 seconds hard limit (returns 408 error if exceeded)

### Monitoring

- **Billing Alerts:** Immediate visibility on unexpected spend
- **CloudWatch Metrics:** Track generation duration, success rate, timeout rate, webhook delivery rate, throttles
- **Logging:** All requests logged with user ID and metadata
- **Timeout Logging:** Timeout events logged in both JobDetails and Analytics tables

---

## Pricing Enforcement

### Free Tier

- **Allowance:** Configurable per plan via `monthly_quota` in `Plans` table (default: 100 PDFs from `FREE_TIER_QUOTA` environment variable)
- **Tracking:** DynamoDB `Users` table
- **No Reset:** Quota is cumulative and does not reset (all-time quota, not monthly)
- **Enforcement:** Checked on every request using `plan.monthly_quota` from `Plans` table
- **After Quota Exceeded:** User must upgrade to paid plan to continue using the service
- **Quota Source:** Quota is read from the plan's `monthly_quota` field in the `Plans` table. If `monthly_quota` is not set for a free plan, it falls back to the `FREE_TIER_QUOTA` environment variable (default: 100)

### Paid Plan

- **Upgrade Required:** Users must upgrade to paid plan after reaching 100 PDFs
- **PDF Limit:** Unlimited PDFs (no quota limit)
- **Free Credits:** Plans may include `free_credits` (e.g., 100 free PDFs). Free credits are consumed first before `price_per_pdf` billing starts.
- **Price:** $0.01 per PDF (charged only after free credits are exhausted)
- **Billing:** Usage tracked per PDF and invoiced monthly. Free credits are used first, then billing applies.
- **Tracking:** 
  - All-time PDF count maintained in `Users` table
  - `free_credits_remaining` in `Users` table tracks remaining free credits (can go negative due to concurrent requests)
  - Monthly billing records stored in `Bills` table (one record per user per month)
  - Each bill record tracks `monthly_pdf_count`, `monthly_billing_amount`, and `is_paid` status
  - Only PDFs that exceed free credits are billed (when `free_credits_remaining <= 0`)
  - Future payment processor integration fields (bill_id, invoice_id, paddle_subscription_id, etc.) can be added to bill records
- **Rate Limits:** Unlimited per-user rate (only limited by API Gateway throttling)

### Implementation Details

1. On each request, Lambda:
   - Extracts user ID (`sub`) from JWT claims
   - Validates user account exists in DynamoDB `Users` table
   - If user record doesn't exist, returns 403 error with `ACCOUNT_NOT_FOUND`
   - Reads `plan_id` and `account_status` from DynamoDB
   - Looks up plan configuration from `Plans` table using `plan_id`
   - For free tier users:
     - Reads total all-time usage from DynamoDB
     - Gets quota limit from `plan.monthly_quota` in `Plans` table (falls back to `FREE_TIER_QUOTA` env var if not set)
     - Compares usage against quota limit
     - Increments counter atomically if within limits
     - Rejects with 403 if quota exceeded
     - Sets `quota_exceeded` flag in `Users` table when quota is exceeded
   - For paid plan users:
     - No quota check (unlimited PDFs by default)
     - Checks if plan has `free_credits` and user has `free_credits_remaining > 0`
     - If free credits available (`free_credits_remaining > 0`):
       - Atomically decrements `free_credits_remaining` in `Users` table
       - No billing charge (free credit used)
     - If free credits exhausted (`free_credits_remaining <= 0`):
       - Charges according to `price_per_pdf` from `Plans` table
       - Creates or updates bill record in `Bills` table for current month
     - Increments PDF count in `Users` table (all-time total) regardless of billing method
     - **Note:** Due to concurrent requests, `free_credits_remaining` can go negative (e.g., `-1`, `-2`). The client should display `0` when the value is `<= 0`, and all subsequent requests will be billed.

2. Account & Plan Management:
   - All users must have an account in DynamoDB `Users` table
   - Accounts are created through the sign-up process
   - Plan assignment is stored via `plan_id` and `account_status`
   - Default plan is a free plan when account is created
   - Plan upgrade updates `plan_id`, `account_status`, and `upgraded_at` timestamp

3. Quota Tracking:
   - Single record per user tracks PDF count and plan in `Users` table
   - Free tier: Tracks all-time count (stops at plan's `monthly_quota` limit, requires upgrade)
   - Quota limit is read from `plan.monthly_quota` in `Plans` table (configurable per plan)
   - If `plan.monthly_quota` is not set, falls back to `FREE_TIER_QUOTA` environment variable (default: 100)
   - Paid plan: Tracks all-time count in `Users` table (unlimited)
   - Monthly billing tracked separately in `Bills` table (one record per user per month)
   - Counter increments with each successful PDF generation (both quick and long jobs)
   - Bill records are created/updated automatically for paid users
   - `quota_exceeded` flag in `Users` table indicates when free tier quota has been exceeded

---

## Cost Profile

### Infrastructure Costs

**Idle Cost:** $0 (pure pay-per-use serverless)

**Per-PDF Cost:** Approximately $0.0005–$0.003 depending on:
- Document complexity
- Page count
- Lambda execution duration
- API Gateway request size
- Job type (quick vs long)

**New Costs (Long Jobs):**
- **S3 Storage:** ~$0.023 per GB/month (minimal for 24-hour retention)
- **S3 Requests:** PUT/GET requests (very low cost)
- **SQS:** $0.40 per million requests (very low cost)

### Pricing Strategy

- **Free Tier:** 100 PDFs (all-time, generous onboarding, then must upgrade)
- **Paid Plan:** $0.01 per PDF, unlimited PDFs, monthly invoicing
- **Expected Gross Margin:** 80–95% at published pricing

### Cost Protection

Multiple protection layers make runaway bills extremely unlikely:

1. **Global Throttling:** Prevents sudden traffic spikes
2. **API Gateway Throttling:** Prevents sudden traffic spikes at the API Gateway level
3. **Per-User Rate Limits:** Prevents individual abuse (free tier users only: 20 requests/minute)
4. **Content Limits:** Prevents resource-intensive requests
5. **QuickJob Timeout:** 30-second limit prevents long-running quick jobs
6. **Budget Alerts:** Early warning system
7. **Authentication Required:** Prevents anonymous abuse
8. **S3 Lifecycle Policy:** Automatic cleanup after 24 hours

---

## Technical Constraints

### Deployment Requirements

- **Serverless Framework:** Version 3.x or higher required
- **Node.js:** Version 20.x (for local development and Lambda runtime)
- **AWS CLI:** Configured with appropriate credentials
- **AWS Account:** Separate accounts or regions recommended for dev/prod isolation

### Lambda Limits

**QuickJob Function:**
- **Maximum Memory:** 10,240 MB (utilized for fastest CPU)
- **Maximum Timeout:** 30 seconds (hard limit)
- **Maximum Payload Size:** 6 MB (request/response)

**LongJob Function:**
- **Maximum Memory:** 1024 MB (minimal, just queues messages)
- **Maximum Timeout:** 30 seconds
- **Maximum Payload Size:** 6 MB (request)

**LongJob Processor Function:**
- **Maximum Memory:** 10,240 MB (utilized for fastest CPU)
- **Maximum Timeout:** 900 seconds (15 minutes)
- **Maximum Payload Size:** 6 MB (SQS message)
- **Concurrent Executions:** Subject to account limits

### Document Limits

- **Maximum Pages:** 100 pages per document (applies to both quick and long jobs)
  - Page count is checked after PDF rendering (actual count, not estimated)
  - PDFs exceeding 100 pages are automatically truncated to first 100 pages
  - Response includes `X-PDF-Truncated` and `X-PDF-Pages` headers to indicate truncation
- **Maximum Input Size:** ~5 MB
- **Enforcement:** Input size rejected with 400 error; page limit enforced via truncation
- **QuickJob Timeout:** 30 seconds hard limit

### Performance Characteristics

- **QuickJob Typical Time:** 1-5 seconds for simple documents
- **QuickJob Complex Documents:** Up to 30 seconds for 100-page documents
- **QuickJob Timeout:** 30 seconds (hard limit, returns 408 error)
- **LongJob Processing:** Variable, depends on document complexity and queue depth
- **S3 Signed URL Expiry:** 1 hour from generation

### Scalability

- **Horizontal Scaling:** Automatic via Lambda concurrency
- **No Bottlenecks:** Fully stateless design
- **DynamoDB:** Handles high-throughput atomic operations
- **API Gateway:** Scales to millions of requests
- **SQS:** Handles high message throughput
- **S3:** Virtually unlimited storage capacity

---

## Summary

PodPDF delivers a clean, secure, and cost-optimized serverless architecture that supports both HTML and Markdown input with dual-endpoint design:

- **QuickJob:** Instant synchronous response for small documents (<30 seconds)
- **LongJob:** Asynchronous queue-based processing with webhook notifications for larger documents

The combination of Cognito authentication, strict limits, layered throttling, timeout protection, and webhook notifications ensures reliability and protection against abuse. With generous free usage and aggressive paid pricing, the service is positioned to capture price-sensitive developers and high-volume automation use cases.

This architecture provides rapid time-to-market, straightforward scalability, and flexible processing options for different document sizes and complexity levels.

---

**Document Version:** 2.0.0  
**Last Updated:** December 21, 2025
