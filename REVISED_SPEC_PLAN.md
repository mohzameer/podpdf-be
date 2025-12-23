# Revised Spec Plan: QuickJob and LongJob Architecture

**Date:** December 21, 2025  
**Status:** Planning Phase

---

## Overview

Replace the single `/generate` endpoint with two specialized endpoints:
- **`POST /quickjob`** - Synchronous PDF generation for small documents (<30 seconds)
- **`POST /longjob`** - Asynchronous PDF generation with queueing, S3 storage, and webhooks

---

## Architecture Changes

### Current Architecture (Single Endpoint)
```
Client → API Gateway → Lambda → PDF (in-memory) → Direct Response
```

### New Architecture (Dual Endpoints)

#### QuickJob Flow (Synchronous)
```
Client → API Gateway → Lambda (quickjob) → PDF (in-memory) → Direct Response
```
- **Timeout:** 30 seconds maximum
- **Response:** PDF binary directly in HTTP response
- **Use Case:** Small PDFs (invoices, receipts, simple reports)

#### LongJob Flow (Asynchronous)
```
Client → API Gateway → Lambda (longjob) → SQS Queue
                                              ↓
                                    Lambda (processor) → PDF → S3 → Webhook Callback
```
- **Timeout:** No client timeout (async processing)
- **Response:** Job ID and status immediately
- **Storage:** PDF stored in S3 with 1-hour signed URL
- **Notification:** Webhook callback to user's configured URL
- **Use Case:** Large PDFs, complex documents, batch processing

---

## New AWS Services Required

### 1. Amazon S3
- **Purpose:** Store generated PDFs for long jobs
- **Bucket Name:** `podpdf-{stage}-pdfs`
- **Configuration:**
  - Private bucket (no public access)
  - Lifecycle policy: Delete objects after 24 hours
  - Encryption: Server-side encryption (SSE-S3)
- **Access:** 1-hour signed URLs generated for download

### 2. Amazon SQS
- **Purpose:** Queue long job processing requests
- **Queue Name:** `podpdf-{stage}-longjob-queue`
- **Configuration:**
  - Standard queue (higher throughput than FIFO)
  - Visibility timeout: 900 seconds (15 minutes)
  - Message retention: 14 days
  - Dead-letter queue: For failed processing after max retries
- **Deduplication:**
  - Standard SQS provides at-least-once delivery (messages may be delivered multiple times)
  - Deduplication handled via DynamoDB `JobDetails` table:
    - Processor checks if job already exists before processing
    - If status is `"completed"` or `"processing"`, skips duplicate message
    - Uses conditional updates to atomically transition status to prevent race conditions

### 3. Additional Lambda Function
- **Function:** `longjob-processor`
- **Trigger:** SQS queue
- **Purpose:** Process queued jobs, generate PDF, upload to S3, call webhook
- **Configuration:**
  - Memory: 10,240 MB (same as quickjob)
  - Timeout: 900 seconds (15 minutes)
  - Concurrency: Process multiple jobs in parallel

---

## API Endpoint Specifications

### 1. POST /quickjob

**Description:** Synchronous PDF generation for small documents that complete in under 30 seconds.

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
  }
}
```

**Response (Success - 200 OK):**
- **Content-Type:** `application/pdf`
- **Headers:**
  - `X-PDF-Pages`: Number of pages
  - `X-PDF-Truncated`: `true` if truncated (if applicable)
  - `X-Job-Id`: Job ID (UUID)
- **Body:** PDF binary data

**Response (Error - 408 Request Timeout):**
- If processing takes longer than 30 seconds, return timeout error
- Suggest using `/longjob` endpoint instead

**Validation:**
- Same validation as current `/generate` endpoint
- Additional check: Estimate processing time (based on content size/complexity)
- If estimated time > 25 seconds, suggest using `/longjob`

---

### 2. POST /longjob

**Description:** Asynchronous PDF generation with queueing, S3 storage, and webhook notifications.

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
  }
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

**Response (Error):**
- Same error responses as `/quickjob` for validation failures
- 400: Invalid input
- 401: Unauthorized
- 403: Rate limit/quota exceeded

**Job Status:**
- `queued`: Job is in SQS queue, waiting to be processed
- `processing`: Job is being processed by Lambda
- `completed`: PDF generated and uploaded to S3
- `failed`: Processing failed (error details in webhook)

---

### 3. GET /jobs/{job_id}

**Description:** Get status and details of a specific job.

**Response (Success - 200 OK):**
```json
{
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "completed",
  "mode": "html",
  "pages": 150,
  "created_at": "2025-12-21T10:30:00Z",
  "completed_at": "2025-12-21T10:32:15Z",
  "s3_url": "https://s3.amazonaws.com/...?X-Amz-Signature=...",
  "s3_url_expires_at": "2025-12-21T11:32:15Z",
  "error_message": null
}
```

**Response (404 Not Found):**
- Job not found or doesn't belong to authenticated user

---

## Webhook Configuration

### User Webhook Setup

**Option 1: Separate Endpoint (Recommended)**
- `PUT /accounts/me/webhook` - Configure webhook URL per user
- Stored in `Users` table as `webhook_url` field

**Option 2: Include in LongJob Request**
- Optional `webhook_url` field in request body
- Overrides user's default webhook URL for this job only

**Webhook Payload (POST to user's URL):**
```json
{
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "completed",
  "s3_url": "https://s3.amazonaws.com/...?X-Amz-Signature=...",
  "s3_url_expires_at": "2025-12-21T11:32:15Z",
  "pages": 150,
  "mode": "html",
  "created_at": "2025-12-21T10:30:00Z",
  "completed_at": "2025-12-21T10:32:15Z"
}
```

**Webhook Error Handling:**
- Retry up to 3 times with exponential backoff
- If all retries fail, log error but mark job as completed
- User can still retrieve PDF via `GET /jobs/{job_id}`

---

## DynamoDB Schema Updates

### Users Table
Add new field:
- `webhook_url` (String, optional): User's default webhook URL for long job notifications

### JobDetails Table
Update fields for both quick and long jobs:
- `job_type` (String, **required**): `"quick"` or `"long"` - Set at job creation to distinguish job type
- `status` (String): `"queued"`, `"processing"`, `"completed"`, `"failed"`, or `"timeout"` (for quick jobs)
- `webhook_url` (String, optional): Webhook URL used for this job (only for long jobs, set at job creation)

Long job specific fields:
- `s3_key` (String, optional): S3 object key for long jobs
- `s3_url` (String, optional): Signed URL for S3 object (1-hour expiry)
- `s3_url_expires_at` (String, optional): ISO 8601 timestamp when signed URL expires
- `webhook_delivered` (Boolean, optional): Whether webhook was successfully delivered
- `webhook_delivered_at` (String, optional): ISO 8601 timestamp when webhook was delivered
- `webhook_retry_count` (Number, optional): Number of webhook retry attempts (0-3)
- `webhook_retry_log` (Array, optional): Array of webhook retry attempt timestamps and results

Quick job specific fields:
- `timeout_occurred` (Boolean, optional): `true` if quick job exceeded 30-second timeout

---

## Implementation Details

### QuickJob Handler (`src/handlers/quickjob.js`)
- Similar to current `generate.js`
- Add timeout check: If processing takes > 30 seconds, return 408 error
- Return PDF directly in response
- Update JobDetails with `job_type: "quick"`

### LongJob Handler (`src/handlers/longjob.js`)
- Validate request (same as quickjob)
- Create job record in DynamoDB with `status: "queued"`, `job_type: "long"`
- Send message to SQS queue with job details
- Return 202 Accepted with job_id
- Include user's webhook_url in SQS message (from Users table)

### LongJob Processor (`src/handlers/longjob-processor.js`)
- Triggered by SQS queue
- **Deduplication Check:**
  - Read job from DynamoDB `JobDetails` table using `job_id` from SQS message
  - If job exists with status `"completed"` or `"processing"`, skip processing (duplicate message)
  - If job doesn't exist or status is `"queued"`, proceed
- **Atomic Status Update:**
  - Use conditional update to atomically change status from `"queued"` to `"processing"`
  - If update fails (status already changed), skip processing (another instance handling it)
- Generate PDF (same logic as quickjob)
- Upload PDF to S3
- Generate 1-hour signed URL
- Update job status to `"completed"` with S3 details
- Call user's webhook URL (if configured)
- Update `webhook_delivered` status

### S3 Service (`src/services/s3.js`)
- `uploadPDF(jobId, pdfBuffer)` - Upload PDF to S3
- `generateSignedUrl(s3Key, expiresIn)` - Generate 1-hour signed URL
- `deletePDF(s3Key)` - Delete PDF after lifecycle expiration

---

## File Changes Required

### 1. SPEC.md
- Complete rewrite with QuickJob and LongJob architecture
- Update all sections to reflect dual-endpoint design
- Add S3, SQS, and webhook documentation

### 2. ENDPOINTS.md
- Replace `/generate` documentation with `/quickjob` and `/longjob`
- Add `GET /jobs/{job_id}` endpoint
- Add `PUT /accounts/me/webhook` endpoint (if Option 1)

### 3. serverless.yml
- Remove `generate` function
- Add `quickjob` function
- Add `longjob` function
- Add `longjob-processor` function (SQS trigger)
- Add S3 bucket permissions
- Add SQS permissions
- Add S3 bucket environment variable

### 4. resources.yml
- Add S3 bucket resource
- Add SQS queue resource
- Add SQS dead-letter queue (optional but recommended)

### 5. Handler Files
- Create `src/handlers/quickjob.js`
- Create `src/handlers/longjob.js`
- Create `src/handlers/longjob-processor.js`
- Delete or archive `src/handlers/generate.js`

### 6. Service Files
- Create `src/services/s3.js` for S3 operations
- Update `src/services/dynamodb.js` if needed for new fields

### 7. Package.json
- Add `@aws-sdk/client-s3` dependency
- Add `@aws-sdk/s3-request-presigner` for signed URLs

---

## Migration Strategy

### Backward Compatibility
- **Option A:** Keep `/generate` endpoint temporarily, route to `/quickjob` internally
- **Option B:** Remove `/generate` immediately (breaking change)
- **Recommendation:** Option A for smooth migration, deprecate after 30 days

### Data Migration
- Existing JobDetails records: Add `job_type: "quick"` to all existing records
- Users table: `webhook_url` field is optional, no migration needed

---

## Testing Considerations

### QuickJob Tests
- Test with small documents (<30s)
- Test timeout behavior with large documents
- Test validation (same as current generate)

### LongJob Tests
- Test job queuing
- Test SQS message processing
- Test S3 upload and signed URL generation
- Test webhook delivery (success and failure cases)
- Test job status retrieval

### Integration Tests
- End-to-end long job flow
- Webhook retry logic
- S3 lifecycle cleanup

---

## Cost Considerations

### New Costs
- **S3 Storage:** ~$0.023 per GB/month (minimal for 24-hour retention)
- **S3 Requests:** PUT/GET requests (very low cost)
- **SQS:** $0.40 per million requests (very low cost)
- **Additional Lambda:** Same cost model as existing Lambda

### Cost Optimization
- S3 lifecycle policy: Delete after 24 hours (reduces storage costs)
- SQS message retention: 14 days (standard)
- Signed URLs: 1-hour expiry (prevents long-term storage of URLs)

---

## Security Considerations

### S3 Security
- Private bucket (no public access)
- Signed URLs with 1-hour expiry
- IAM role-based access (no public access)

### Webhook Security
- Validate webhook URLs (must be HTTPS)
- Optional: Add webhook signature verification
- Rate limit webhook calls

### SQS Security
- Queue access restricted to Lambda role
- Message encryption in transit (SQS default)

---

## Decisions Made

1. **Webhook Setup Method:**
   - ✅ **Both** - Separate endpoint (`PUT /accounts/me/webhook`) for default webhook URL, with option to override in longjob request body

2. **QuickJob Timeout:**
   - ✅ **Hard 30-second timeout** - Return 408 error if processing exceeds 30 seconds
   - ✅ **Logging** - Timeout events logged in both JobDetails and Analytics tables

3. **LongJob Page Limits:**
   - ✅ **Keep 100-page limit** - Long jobs also subject to 100-page truncation (same as quick jobs)

4. **Backward Compatibility:**
   - ✅ **Remove `/generate` immediately** - No backward compatibility needed, breaking change

5. **Webhook Retry Strategy:**
   - ✅ **3 retries with exponential backoff** - Retry failed webhook calls up to 3 times
   - ✅ **Logging** - Webhook retry attempts and final status logged in both JobDetails and Analytics tables

---

## Next Steps

1. Review and approve this plan
2. Answer open questions above
3. Begin implementation starting with infrastructure (S3, SQS)
4. Implement handlers in order: quickjob → longjob → processor
5. Update documentation
6. Testing and validation

---

**Document Version:** 1.0  
**Last Updated:** December 21, 2025

