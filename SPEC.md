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
- **Authorization:** JWT authorizer integrated with Amazon Cognito

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
     - `webhook_url` (String, optional) - User's default webhook URL for long job notifications
     - `created_at` (String, ISO 8601 timestamp) - Account creation timestamp
     - `upgraded_at` (String, ISO 8601 timestamp, optional) - Timestamp when user upgraded to paid plan
   - **TTL:** Not applicable (permanent storage for user records)

2. **UserRateLimits**
   - **Partition Key:** `user_sub` (Cognito user identifier - for fast lookups from JWT token)
   - **Sort Key:** `minute_timestamp` (format: YYYY-MM-DD-HH-MM)
   - **Attributes:**
     - `user_sub` (String) - Cognito user identifier (partition key)
     - `user_id` (String, optional) - ULID user identifier (for consistency with Users table)
     - `minute_timestamp` (String) - Timestamp in format YYYY-MM-DD-HH-MM (sort key)
     - `request_count` (Number, atomic counter) - Number of requests in this minute window
     - `ttl` (Number, expires after 1 hour) - Time-to-live for automatic cleanup

3. **JobDetails**
   - **Partition Key:** `job_id` (UUID, generated per PDF generation request)
   - **Attributes:**
     - `user_sub` (String) - User identifier from Cognito
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
     - `price_per_pdf` (Number) - Price per PDF (e.g., `0` for free, `0.005` for paid)
     - `rate_limit_per_minute` (Number, optional) - Per-user rate limit (e.g., `20` for free, `null` or higher value for paid)
     - `description` (String, optional) - Description of the plan
     - `is_active` (Boolean) - Indicates if plan is active and available for assignment
   - **TTL:** Not applicable (plan configurations are long-lived)

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
   - Client sends `POST /quickjob` with JSON payload containing:
     - `input_type` (string, required): Either `"html"` or `"markdown"`
     - `html` (string, optional): HTML content (required if `input_type` is `"html"`)
     - `markdown` (string, optional): Markdown content (required if `input_type` is `"markdown"`)
     - `options` (object, optional): Rendering options

3. **API Gateway Processing**
   - Validates the JWT using the Cognito authorizer
   - Applies global throttling
   - Routes valid request to Lambda function

4. **Lambda Handler Execution (quickjob)**
   
   **Validation Phase:**
   - Extracts user ID (`sub`) from JWT claims
   - Validates user account exists: Retrieves user record from DynamoDB `Users` table
   - If user record doesn't exist, rejects with 403 error
   - Reads user plan from DynamoDB
   - Validates request body (same validation as described in API Specification)
   - Enforces per-user rate limit for free tier users only (20 requests/minute)
   - Checks all-time quota for free tier users (100 PDFs)
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
   - Validates the JWT using the Cognito authorizer
   - Applies global throttling
   - Routes valid request to Lambda function

4. **Lambda Handler Execution (longjob)**
   
   **Validation Phase:**
   - Same validation as QuickJob (user account, request body, rate limits, quota)
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

### Request Validation

All requests are validated in the following order:

1. **Authentication Validation:**
   - JWT token must be present and valid (401 if missing or invalid)
   - User ID (`sub`) must be extracted from JWT claims

2. **Account Validation:**
   - User account must exist in DynamoDB `Users` table
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

---

## Security & Abuse Protection

### Authentication

- **Mandatory:** All requests require valid Cognito JWT token
- **No unauthenticated access** allowed

### Throttling Layers

1. **Global Throttling (API Gateway)**
   - 1000 requests/second with 2000 burst capacity
   - Applied at the API Gateway level for all requests

2. **Per-User Rate Limiting (Lambda)**
   - Enforced in code using DynamoDB atomic counters
   - **Free Tier:** 20 requests/minute (enforced per user)
   - **Paid Tier:** Unlimited (only limited by API Gateway global throttling)

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

- **Allowance:** 100 PDFs (all-time quota, not monthly)
- **Tracking:** DynamoDB `Users` table
- **No Reset:** Quota is cumulative and does not reset
- **Enforcement:** Checked on every request
- **After 100 PDFs:** User must upgrade to paid plan to continue using the service

### Paid Plan

- **Upgrade Required:** Users must upgrade to paid plan after reaching 100 PDFs
- **PDF Limit:** Unlimited PDFs (no quota limit)
- **Price:** $0.005 per PDF
- **Billing:** Usage tracked per PDF and invoiced monthly
- **Tracking:** DynamoDB `Users` table maintains accurate PDF counts for monthly invoicing
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
     - Compares against quota (100 PDFs)
     - Increments counter atomically if within limits
     - Rejects with 403 if quota exceeded
   - For paid plan users:
     - No quota check (unlimited PDFs by default)
     - Increments PDF count for monthly invoicing
     - All PDFs are billed according to `price_per_pdf` from `Plans` table

2. Account & Plan Management:
   - All users must have an account in DynamoDB `Users` table
   - Accounts are created through the sign-up process
   - Plan assignment is stored via `plan_id` and `account_status`
   - Default plan is a free plan when account is created
   - Plan upgrade updates `plan_id`, `account_status`, and `upgraded_at` timestamp

3. Quota Tracking:
   - Single record per user tracks PDF count and plan
   - Free tier: Tracks all-time count (stops at 100, requires upgrade)
   - Paid plan: Tracks monthly count for invoicing (unlimited)
   - Counter increments with each successful PDF generation (both quick and long jobs)

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
- **Paid Plan:** $0.005 per PDF, unlimited PDFs, monthly invoicing
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
