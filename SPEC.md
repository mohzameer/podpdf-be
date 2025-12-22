# PodPDF API Specification

**Version:** 1.0.0 (MVP – Synchronous Only)  
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

The MVP remains deliberately simple and fully synchronous:

- A single HTTP request contains either HTML or Markdown input
- The service immediately renders and returns the PDF binary in the response
- No queues, no asynchronous jobs, no polling, no temporary storage
- Hard limit of **100 pages per document** - PDFs exceeding this limit are automatically truncated to the first 100 pages to ensure reliable execution within Lambda constraints

This design prioritizes:
- **Developer experience** (instant response)
- **Operational simplicity
- **Minimal running costs** while supporting the majority of real-world use cases (invoices, reports, contracts, documentation, receipts)

---

## Architecture

### Infrastructure as Code

- **Deployment Framework:** Serverless Framework 3.x or higher
- **Configuration:** All AWS resources defined in `serverless.yml`
- **Environment Management:** Separate stacks for development and production environments

### Core Principles

1. **Fully Synchronous**: Every request is processed immediately and returns the PDF in the response
2. **Serverless-First**: Zero idle costs, pure pay-per-use model
3. **Single Lambda Function**: One function handles all processing logic
4. **No External Storage**: PDFs are generated in-memory and returned directly

### System Components

```
Client → API Gateway → Lambda (with Chromium Layer) → DynamoDB (usage tracking)
         ↓
      Cognito (Auth)
```

---

## AWS Services

### Amazon API Gateway

**Purpose:** Secure public HTTPS endpoint

**Configuration:**
- **Type:** HTTP API (v2) – cost-effective and low-latency
- **Response Encoding:** API Gateway is configured with `application/pdf` as a binary media type and forwards the Lambda response as a pure binary PDF stream. Clients always receive a standard binary PDF response on the wire (no base64 encoding required or exposed).
- **CORS:** Enabled
- **Throttling:** 
  - Global: 1000 requests/second with 2000 burst
- **Authorization:** JWT authorizer integrated with Amazon Cognito

### AWS Lambda

**Purpose:** Core application logic and PDF rendering

**Configuration:**
- **Runtime:** Node.js 20.x
- **Memory:** 10,240 MB (maximum for fastest CPU)
- **Timeout:** 720 seconds (12 minutes)
- **Layer:** `@sparticuz/chromium` (optimized headless Chromium binary for Lambda)
- **Markdown Processing:** Lightweight library (marked or markdown-it)

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
   - **Partition Key:** `user_sub` (user identifier from Cognito)
   - **Attributes:** 
     - `plan_id` (String) - ID of the plan this user is on (e.g., `"free-basic"`, `"paid-standard"`)
     - `account_status` (String) - `"free"`, `"paid"`, or `"cancelled"` (defaults to `"free"` on account creation)
     - `total_pdf_count` (Number) - All-time PDF count for the user
     - `created_at` (String, ISO 8601 timestamp) - Account creation timestamp
     - `upgraded_at` (String, ISO 8601 timestamp, optional) - Timestamp when user upgraded to paid plan
   - **TTL:** Not applicable (permanent storage for user records)

2. **UserRateLimits**
   - **Partition Key:** `user_sub`
   - **Sort Key:** `minute_timestamp` (format: YYYY-MM-DD-HH-MM)
   - **Attributes:**
     - `request_count` (Number, atomic counter)
     - `ttl` (Number, expires after 1 hour)

3. **JobDetails**
   - **Partition Key:** `job_id` (UUID, generated per PDF generation request)
   - **Attributes:**
     - `user_sub` (String) - User identifier from Cognito
     - `status` (String) - Job status: `"success"` or `"failure"`
     - `mode` (String) - Input mode: `"html"` or `"markdown"`
     - `pages` (Number) - Number of pages in the returned PDF (after any truncation)
     - `truncated` (Boolean) - `true` if the PDF was truncated to 100 pages, `false` otherwise
     - `created_at` (String, ISO 8601 timestamp) - Job creation timestamp
     - `completed_at` (String, ISO 8601 timestamp) - Job completion timestamp
     - `error_message` (String, optional) - Error message if status is `"failure"`
   - **TTL:** Not applicable (permanent storage for job history)

4. **Analytics**
   - **Partition Key:** `job_id` (UUID, same as JobDetails for correlation)
   - **Attributes:**
     - `country` (String) - Country code (derived from request IP or user location)
     - `job_duration` (Number) - Job execution duration in milliseconds
     - `mode` (String) - Input mode: `"html"` or `"markdown"`
     - `pages` (Number) - Number of pages in the generated PDF
     - `status` (String) - Job status: `"success"` or `"failure"`
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

### AWS WAF

**Purpose:** Additional protection against IP-based abuse for all users

**Configuration:**
- **AWS Pricing Tier:** AWS WAF Free Tier only (no paid WAF features)
- **Rate-based rule:** Block >2000 requests/5 minutes per IP
- **Cost:** $0 (uses only AWS WAF free tier features)
- **Applies To:** All users (both free tier and paid tier users)

**Note:** Only basic rate-based rules are used, which are included in the AWS WAF free tier. No advanced features, managed rule groups, or other paid WAF components are utilized. WAF protection applies to all users regardless of their pricing tier (free or paid).

### Amazon CloudWatch

**Purpose:** Logging, metrics, and monitoring

**Configuration:**
- Standard Lambda logs and metrics
- Custom metrics:
  - Generation duration
  - Success rate
  - Throttle events

### AWS Budgets & Billing

**Purpose:** Cost protection and early warnings

**Configuration:**
- Monthly budget alerts at low thresholds (e.g., $10, $50)
- Forecasted spend notifications

---

## Data Flow

### Synchronous Request Flow

1. **Authentication**
   - Client authenticates via Cognito and receives a JWT token

2. **Request Submission**
   - Client sends `POST /generate` with JSON payload containing:
     - `input_type` (string, required): Either `"html"` or `"markdown"`
     - `html` (string, optional): HTML content (required if `input_type` is `"html"`)
     - `markdown` (string, optional): Markdown content (required if `input_type` is `"markdown"`)
     - `options` (object, optional): Rendering options

3. **API Gateway Processing**
   - Validates the JWT using the Cognito authorizer
   - Applies global throttling and WAF rules
   - Routes valid request to Lambda function

4. **Lambda Handler Execution**
   
   **Validation Phase:**
   - Extracts user ID (`sub`) from JWT claims
   - Validates user account exists: Retrieves user record from DynamoDB `Users` table
   - If user record doesn't exist, rejects with 403 error (user must have an account - both free and paid users require account creation)
   - Reads user plan from DynamoDB (`plan` attribute: `"free"` or `"paid"`)
   - Validates request body:
     - `input_type` must be either `"html"` or `"markdown"` (400 error if invalid or missing)
     - Both `html` and `markdown` fields cannot be provided simultaneously (400 error if both present)
     - If `input_type` is `"html"`:
       - `html` field must be present and non-empty (400 error if missing or empty)
       - `markdown` field must not be present (400 error if present)
     - If `input_type` is `"markdown"`:
       - `markdown` field must be present and non-empty (400 error if missing or empty)
       - `html` field must not be present (400 error if present)
     - Validates content matches declared type by checking starting tags:
       - For `input_type: "html"`: Content should start with HTML tags (e.g., `<!DOCTYPE`, `<html`, `<div`, etc.)
       - For `input_type: "markdown"`: Content should not start with HTML tags (400 error if HTML tags detected)
   - Enforces per-user rate limit for free tier users only (20 requests/minute via DynamoDB atomic counter)
   - Paid tier users have unlimited rate (only limited by WAF and API Gateway throttling)
   - Checks all-time quota for free tier users (100 PDFs; after quota, user must upgrade to paid plan)
   - Paid plan users have unlimited PDFs (no quota check, usage tracked for monthly invoicing)
   - Validates input size limits (~5 MB maximum, 400 error if exceeded)

   **Processing Phase (if checks pass):**
   - Generates unique `job_id` (UUID) for this request
   - Records job start time for duration tracking
   - If `input_type` is `"markdown"`, converts Markdown to HTML using lightweight library
   - Launches headless Chromium (via layer)
   - Renders the final HTML content
   - Generates the PDF using Puppeteer `page.pdf()` with user-provided options
   - Checks page count: After PDF generation, counts actual pages in the rendered PDF
   - If PDF exceeds 100 pages, truncates to first 100 pages (page count checked after rendering)
   - Records job completion (on both success and failure):
     - Writes to `JobDetails` table: user info, job status (`"success"` or `"failure"`), mode, pages (returned page count), `truncated` flag, timestamps, error message (if failure)
     - Writes to `Analytics` table: country, job duration, mode, pages (returned page count), status (no user info)
   - On success: Returns the PDF binary directly in the response (truncated if necessary)
   - On failure: Returns appropriate error response (500 for processing failures, 400 for validation failures)

5. **Success Response**
   - **Status:** 200 OK
   - **Content-Type:** `application/pdf`
   - **Content-Disposition:** `inline; filename="document.pdf"`
   - **X-PDF-Pages:** Number of pages in the returned PDF (may be truncated)
   - **X-PDF-Truncated:** `true` if PDF was truncated to 100 pages, `false` otherwise (optional header)
   - **X-Job-Id:** Job ID (UUID) for tracking and correlation with analytics
   - **Body:** Raw PDF binary data (truncated to 100 pages maximum if original exceeded limit)

---

## API Specification

### Endpoint

```
POST /generate
```

### Authentication

**Required:** JWT Bearer Token in Authorization header

```
Authorization: Bearer <jwt_token>
```

### Request Body

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

Or for Markdown:

```json
{
  "input_type": "markdown",
  "markdown": "# Title\n\nThis is markdown content with **bold** text.",
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

**Request Body Fields:**
- `input_type` (string, required): Must be either `"html"` or `"markdown"`
- `html` (string, required if `input_type` is `"html"`): HTML content to render
- `markdown` (string, required if `input_type` is `"markdown"`): Markdown content to render
- `options` (object, optional): PDF rendering options (see below)

**Validation Rules:**
- `input_type` must be present and one of: `"html"` or `"markdown"` (400 error if missing or invalid)
- Both `html` and `markdown` fields cannot be provided simultaneously (400 error if both are present)
- If `input_type` is `"html"`:
  - `html` field must be present and non-empty (400 error if missing or empty)
  - `markdown` field must not be present (400 error if present)
- If `input_type` is `"markdown"`:
  - `markdown` field must be present and non-empty (400 error if missing or empty)
  - `html` field must not be present (400 error if present)
- Content validation: The system checks starting tags to ensure content matches the declared `input_type`:
  - HTML content should start with HTML tags (e.g., `<!DOCTYPE`, `<html`, `<div`, `<p`, etc.)
  - Markdown content should not start with HTML tags (will return 400 error if HTML tags are detected)

### Request Validation

All requests are validated in the following order:

1. **Authentication Validation:**
   - JWT token must be present and valid (401 if missing or invalid)
   - User ID (`sub`) must be extracted from JWT claims

2. **Account Validation:**
   - User account must exist in DynamoDB `Users` table
   - Both free tier and paid plan users require an account
   - If account doesn't exist, returns 403 error with `ACCOUNT_NOT_FOUND` code
   - Account must be created through sign-up process before using the API

3. **Request Body Validation:**
   - `input_type` field validation (400 if missing or invalid)
   - Content field validation (400 if missing, empty, or wrong field provided)
   - Content type validation (400 if content doesn't match declared type)
   - Input size validation (400 if exceeds ~5 MB limit)

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

### Response

**Success (200 OK):**
- **Content-Type:** `application/pdf`
- **Content-Disposition:** `inline; filename="document.pdf"`
- **X-PDF-Pages:** Number of pages in the returned PDF (e.g., `100` if truncated, or actual count if ≤100)
- **X-PDF-Truncated:** `true` if PDF was truncated to 100 pages, `false` otherwise (optional header)
- **X-Job-Id:** Job ID (UUID) for tracking and correlation with analytics
- **Body:** PDF binary data (truncated to 100 pages maximum if original exceeded limit)

**Error Responses:**

| Status Code | Description |
|------------|-------------|
| 400 | Bad Request - Invalid/missing input_type, missing/empty content field, both fields provided, wrong field provided, content type mismatch, or exceeds size limit |
| 401 | Unauthorized - Invalid or missing JWT token |
| 403 | Forbidden - Account not found, per-user rate limit exceeded (free tier: 20/min), or quota exhausted (upgrade to paid plan required). Returns `ACCOUNT_NOT_FOUND`, `RATE_LIMIT_EXCEEDED`, or `QUOTA_EXCEEDED` error code. |
| 429 | Too Many Requests - Global throttling (API Gateway: 1000/sec) or WAF IP rate limit (2000/5min) reached. This is returned by API Gateway/WAF before reaching Lambda. |
| 500 | Internal Server Error - Processing failure |

### Error Response Format

**Quota Exceeded:**
```json
{
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "All-time quota of 100 PDFs has been reached. Please upgrade to a paid plan to continue using the service.",
    "details": {
      "current_usage": 100,
      "quota": 100,
      "action_required": "upgrade_to_paid_plan"
    }
  }
}
```

**Invalid Input Type:**
```json
{
  "error": {
    "code": "INVALID_INPUT_TYPE",
    "message": "input_type must be either 'html' or 'markdown'",
    "details": {
      "provided": "xml",
      "allowed": ["html", "markdown"]
    }
  }
}
```

**Missing Input Type:**
```json
{
  "error": {
    "code": "MISSING_INPUT_TYPE",
    "message": "input_type field is required",
    "details": {
      "required": "input_type"
    }
  }
}
```

**Missing Content Field:**
```json
{
  "error": {
    "code": "MISSING_CONTENT_FIELD",
    "message": "html field is required when input_type is 'html'",
    "details": {
      "input_type": "html",
      "missing_field": "html"
    }
  }
}
```

**Empty Content Field:**
```json
{
  "error": {
    "code": "EMPTY_CONTENT_FIELD",
    "message": "html field cannot be empty",
    "details": {
      "input_type": "html",
      "field": "html"
    }
  }
}
```

**Both Fields Provided:**
```json
{
  "error": {
    "code": "CONFLICTING_FIELDS",
    "message": "Both html and markdown fields cannot be provided. Provide only the field matching your input_type.",
    "details": {
      "input_type": "html",
      "conflict": "markdown field should not be present when input_type is 'html'"
    }
  }
}
```

**Wrong Field Provided:**
```json
{
  "error": {
    "code": "WRONG_FIELD_PROVIDED",
    "message": "html field should not be present when input_type is 'markdown'",
    "details": {
      "input_type": "markdown",
      "invalid_field": "html"
    }
  }
}
```

**Content Type Mismatch:**
```json
{
  "error": {
    "code": "CONTENT_TYPE_MISMATCH",
    "message": "Content appears to be HTML but input_type is 'markdown'",
    "details": {
      "input_type": "markdown",
      "detected_type": "html",
      "reason": "Content starts with HTML tags"
    }
  }
}
```

**Account Not Found:**
```json
{
  "error": {
    "code": "ACCOUNT_NOT_FOUND",
    "message": "User account not found. Please create an account before using the API.",
    "details": {
      "action_required": "create_account"
    }
  }
}
```

**Rate Limit Exceeded (Free Tier):**
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded",
    "details": {
      "limit": 20,
      "window": "1 minute",
      "retry_after": 30,
      "type": "per_user_rate_limit"
    }
  }
}
```


**Note on Rate Limits:**
- **403 with `RATE_LIMIT_EXCEEDED`**: Per-user rate limit for free tier users (20 requests/minute) - returned by Lambda
- **403 with `QUOTA_EXCEEDED`**: All-time PDF quota exhausted (100 PDFs) - returned by Lambda
- **429**: Global throttling (API Gateway: 1000 requests/second) or WAF IP rate limit (2000 requests/5 minutes per IP) - returned by API Gateway/WAF before reaching Lambda

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

2. **Per-IP Protection (WAF - AWS Free Tier Features)**
   - Rate-based rule: Block >2000 requests/5 minutes per IP
   - Uses only AWS WAF free tier features (no additional cost)
   - Applies to all users (both free tier and paid tier users)
   - Basic rate limiting at IP level

3. **Per-User Rate Limiting (Lambda)**
   - Enforced in code using DynamoDB atomic counters
   - **Free Tier:** 20 requests/minute (enforced per user)
   - **Paid Tier:** Unlimited (only limited by WAF and API Gateway global throttling)

### Content Limits

- **Page Limit:** 100 pages per document (hard limit)
  - Page count is determined after PDF rendering (not estimated)
  - If rendered PDF exceeds 100 pages, it is automatically truncated to the first 100 pages
  - Truncated PDFs are returned with `X-PDF-Truncated: true` header and `X-PDF-Pages: 100` header
  - This ensures accurate page counting based on actual rendered output
- **Input Size:** ~5 MB maximum
- **Enforcement:** Input size rejected with 400 error if exceeded; page limit enforced via truncation

### Monitoring

- **Billing Alerts:** Immediate visibility on unexpected spend
- **CloudWatch Metrics:** Track generation duration, success rate, throttles
- **Logging:** All requests logged with user ID and metadata

---

## Pricing Enforcement

### Free Tier

- **Allowance:** 100 PDFs (all-time quota, not monthly)
- **Tracking:** DynamoDB `Users` table
- **No Reset:** Quota is cumulative and does not reset
- **Enforcement:** Checked on every request
- **After 100 PDFs:** User must upgrade to paid plan to continue using the service (no free tier access after quota is exhausted)

### Paid Plan

- **Upgrade Required:** Users must upgrade to paid plan after reaching 100 PDFs
- **PDF Limit:** Unlimited PDFs (no quota limit)
- **Price:** $0.005 per PDF
- **Billing:** Usage tracked per PDF and invoiced monthly
- **Tracking:** DynamoDB `Users` table maintains accurate PDF counts for monthly invoicing
- **Rate Limits:** Unlimited per-user rate (only limited by WAF and API Gateway throttling)

### Implementation Details

1. On each request, Lambda:
   - Extracts user ID (`sub`) from JWT claims
   - Validates user account exists in DynamoDB `Users` table
   - If user record doesn't exist, returns 403 error with `ACCOUNT_NOT_FOUND` (user must create account first)
   - Reads `plan_id` and `account_status` from DynamoDB (`Users` record)
   - Looks up plan configuration from `Plans` table using `plan_id`
   - For free tier users (`account_status: "free"` and plan `type: "free"`):
     - Reads total all-time usage from DynamoDB
     - Compares against quota (100 PDFs)
     - Increments counter atomically if within limits
     - Rejects with 403 if quota exceeded (user must upgrade to paid plan)
   - For paid plan users (`account_status: "paid"` and plan `type: "paid"`):
     - No quota check (unlimited PDFs by default)
     - Increments PDF count for monthly invoicing
     - All PDFs are billed according to `price_per_pdf` from `Plans` table (e.g., $0.005 per PDF)

2. Account & Plan Management:
   - All users (free tier and paid plan) must have an account in DynamoDB `Users` table
   - Accounts are created through the sign-up process (not auto-created on first API call)
   - Plan assignment is stored via `plan_id` (foreign key to `Plans` table) and `account_status`
   - Default plan is a free plan (e.g., `plan_id: "free-basic"`, `account_status: "free"`) when account is created during sign-up
   - Plan upgrade is handled by:
     - Updating `plan_id` to a paid plan (e.g., `"paid-standard"`)
     - Updating `account_status` to `"paid"`
     - Setting `upgraded_at` timestamp when plan is upgraded
   - Plan and pricing configuration (quota, rate limits, price per PDF) are defined centrally in the `Plans` table
   - Plan information is not stored in Cognito (only user authentication)

3. Quota Tracking:
   - Single record per user tracks PDF count and plan
   - Free tier: Tracks all-time count (stops at 100, requires upgrade)
   - Paid plan: Tracks monthly count for invoicing (unlimited)
   - Counter increments with each successful PDF generation

4. Monthly Invoicing (Paid Plan):
   - PDF usage is tracked per calendar month
   - Users are invoiced monthly based on PDF count × $0.005
   - Usage resets at the start of each calendar month for billing purposes
   - Historical usage data is maintained for records

---

## Cost Profile

### Infrastructure Costs

**Idle Cost:** $0 (pure pay-per-use serverless)

**Per-PDF Cost:** Approximately $0.0005–$0.003 depending on:
- Document complexity
- Page count
- Lambda execution duration
- API Gateway request size

### Pricing Strategy

- **Free Tier:** 100 PDFs (all-time, generous onboarding, then must upgrade)
- **Paid Plan:** $0.005 per PDF, unlimited PDFs, monthly invoicing
- **Expected Gross Margin:** 80–95% at published pricing

### Cost Protection

Multiple protection layers make runaway bills extremely unlikely:

1. **Global Throttling:** Prevents sudden traffic spikes (applies to all users)
2. **Per-IP Protection (WAF - AWS Free Tier Features):** Prevents IP-based abuse at no cost using AWS WAF free tier features (applies to all users regardless of pricing tier)
3. **Per-User Rate Limits:** Prevents individual abuse (free tier users only: 20 requests/minute; paid tier users unlimited)
4. **Content Limits:** Prevents resource-intensive requests
5. **Budget Alerts:** Early warning system
6. **Authentication Required:** Prevents anonymous abuse

---

## Technical Constraints

### Deployment Requirements

- **Serverless Framework:** Version 3.x or higher required
- **Node.js:** Version 20.x (for local development and Lambda runtime)
- **AWS CLI:** Configured with appropriate credentials
- **AWS Account:** Separate accounts or regions recommended for dev/prod isolation

### Lambda Limits

- **Maximum Memory:** 10,240 MB (utilized for fastest CPU)
- **Maximum Timeout:** 720 seconds (12 minutes)
- **Maximum Payload Size:** 6 MB (request/response)
- **Concurrent Executions:** Subject to account limits

### Document Limits

- **Maximum Pages:** 100 pages per document
  - Page count is checked after PDF rendering (actual count, not estimated)
  - PDFs exceeding 100 pages are automatically truncated to first 100 pages
  - Response includes `X-PDF-Truncated` and `X-PDF-Pages` headers to indicate truncation
  - Ensures accurate page counting based on final rendered output
- **Maximum Input Size:** ~5 MB
- **Enforcement:** Input size rejected with 400 error; page limit enforced via truncation

### Performance Characteristics

- **Typical Generation Time:** 1-5 seconds for simple documents
- **Complex Documents:** Up to 30 seconds for 100-page documents
- **Timeout Buffer:** 12-minute timeout provides significant safety margin

### Scalability

- **Horizontal Scaling:** Automatic via Lambda concurrency
- **No Bottlenecks:** Fully stateless design
- **DynamoDB:** Handles high-throughput atomic operations
- **API Gateway:** Scales to millions of requests

---

## Summary

PodPDF delivers a clean, secure, and cost-optimized serverless architecture that supports both HTML and Markdown input while maintaining instant synchronous responses. The combination of Cognito authentication, strict limits, and layered throttling ensures reliability and protection against abuse. With generous free usage and aggressive paid pricing, the service is positioned to capture price-sensitive developers and high-volume automation use cases from day one.

This foundation provides rapid time-to-market and straightforward scalability as the product evolves.

---

## Future Considerations (Post-MVP)

While the MVP is deliberately synchronous and simple, future enhancements may include:

- Asynchronous job processing for large documents
- Webhook notifications for completed jobs
- Temporary storage for generated PDFs
- Batch processing capabilities
- Custom templates and styling options
- Advanced rendering options (watermarks, headers/footers)
- Multi-format output (PNG, JPEG from same source)

---

**Document Version:** 1.0.0  
**Last Updated:** December 21, 2025

