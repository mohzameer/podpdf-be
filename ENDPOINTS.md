## PodPDF API Endpoints

This document describes the public HTTP endpoints exposed by the PodPDF API.

All endpoints are served via **Amazon API Gateway HTTP API (v2)** and backed by Lambda functions.

**Note:** User account creation is handled automatically via a **Cognito Post Confirmation Lambda trigger**. When a user signs up via the `POST /signup` endpoint and confirms their email with the verification code, the account record is automatically created in DynamoDB. The `POST /accounts` endpoint is available as a fallback for manual account creation if needed.

---

## Error Response Format

All error responses follow a standardized format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message",
    "details": {
      // Additional error-specific details
      // May include: parameter, action_required, limit, quota, etc.
    }
  }
}
```

**Key Fields:**
- **`code`** (string): Machine-readable error code (e.g., `INVALID_PARAMETER`, `ACCOUNT_NOT_FOUND`)
- **`message`** (string): Human-readable error message describing what went wrong
- **`details`** (object): Additional context-specific information:
  - For `INVALID_PARAMETER`: Contains `parameter` and `message` fields
  - For `QUOTA_EXCEEDED`: Contains `current_usage`, `quota`, `quota_exceeded`, `action_required`
  - For `RATE_LIMIT_EXCEEDED`: Contains `limit`, `window`, `retry_after`, `type`
  - For most errors: Contains `action_required` field with guidance

**Common Error Codes:**
- `INVALID_PARAMETER` - Invalid or missing request parameters (400)
- `ACCOUNT_NOT_FOUND` - User account not found (403)
- `QUOTA_EXCEEDED` - Usage quota exceeded (403)
- `RATE_LIMIT_EXCEEDED` - Rate limit exceeded (403)
- `UNAUTHORIZED` - Missing or invalid authentication (401)
- `NOT_FOUND` - Resource not found (404)
- `INTERNAL_SERVER_ERROR` - Server-side error (500)

For detailed error code documentation, see `ERRORS.md`.

---

## 1. `POST /quickjob`

**Description:**  
Synchronous PDF generation for small documents that complete in under 30 seconds. Returns PDF binary directly in HTTP response.

### 1.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito) **OR** API Key
- **Note:** No API Gateway authorizer is used. Authentication is handled directly in Lambda to support both JWT and API key.
- **Headers (choose one):**

**Option 1: JWT Token (ID Token)**
```http
Authorization: Bearer <id_token>
```

**Option 2: API Key**
```http
X-API-Key: <api_key>
```
or
```http
Authorization: Bearer <api_key>
```

**Requirements:**
- Either a valid JWT token or a valid API key must be provided.
- **JWT Token Requirements:**
  - Must be the **ID token** (not access token) from Cognito `/signin` response
  - Token is verified directly in Lambda against Cognito JWKS (public keys)
  - Validates issuer, audience, expiration, algorithm (RS256), and `token_use: id`
- **API Key Requirements:**
  - API key must be active and not revoked
  - API keys start with `pk_live_` or `pk_test_`
- User account must exist in `Users` (no anonymous or first-call auto-account creation).
- **Note:** If both are provided, API key takes precedence.

### 1.2 HTTP Request

**Method:** `POST`  
**Path:** `/quickjob`  
**Content-Type:** `application/json` (for HTML/Markdown) or `multipart/form-data` (for Images)

#### 1.2.1 Request Body (HTML)

```json
{
  "input_type": "html",
  "html": "<!DOCTYPE html><html><head><title>Invoice</title></head><body><h1>Invoice</h1><p>Thank you!</p></body></html>",
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

#### 1.2.2 Request Body (Markdown)

```json
{
  "input_type": "markdown",
  "markdown": "# Report\n\nThis is **markdown** content with a table:\n\n| Col A | Col B |\n|------|------|\n|  1   |  2   |",
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

#### 1.2.3 Request Body (Images - Multipart)

**Content-Type:** `multipart/form-data`

```bash
# cURL example
curl -X POST https://api.podpdf.com/quickjob \
  -H "Authorization: Bearer <token>" \
  -F "input_type=image" \
  -F "images=@photo1.png" \
  -F "images=@photo2.jpg" \
  -F 'options={"format":"A4","fit":"contain"}'
```

```javascript
// JavaScript/Browser example
const formData = new FormData();
formData.append('input_type', 'image');
formData.append('images', file1);  // File object from input[type=file]
formData.append('images', file2);
formData.append('options', JSON.stringify({
  format: 'A4',
  margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
  fit: 'contain'
}));

const response = await fetch('/quickjob', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` },
  body: formData
});
```

**Form Fields:**
- `input_type` (string, required): Must be `"image"`
- `images` (file, required): One or more image files (PNG or JPEG). Repeat field for multiple images.
- `options` (string, optional): JSON string with PDF options

#### 1.2.4 Request Fields

**For HTML/Markdown (JSON):**
- `input_type` (string, required)
  - Must be `"html"` or `"markdown"`.
- `html` (string, required if `input_type` is `"html"`)
  - Full HTML content to render.
- `markdown` (string, required if `input_type` is `"markdown"`)
  - Markdown content to render (GitHub-flavored).
- `options` (object, optional)
  - Passed to Puppeteer `page.pdf()`:
    - `format` (string): `"A4"`, `"Letter"`, etc.
    - `margin` (object): `top`, `right`, `bottom`, `left` (e.g., `"20mm"`).
    - `printBackground` (boolean): default `true`.
    - `scale` (number): default `1.0`.
    - `landscape` (boolean): default `false`.
    - `preferCSSPageSize` (boolean): default `false`.

**For Images (Multipart):**
- `input_type` (string, required): Must be `"image"`
- `images` (file, required): One or more PNG/JPEG image files
- `options` (string, optional): JSON string with options:
  - `format` (string): Page size `"A4"`, `"Letter"`, etc. Default: `"A4"`
  - `margin` (object): `top`, `right`, `bottom`, `left` (e.g., `"10mm"`). Default: `10mm` all sides
  - `fit` (string): How to fit image on page:
    - `"contain"` (default): Fit whole image, maintain aspect ratio
    - `"cover"`: Fill entire page, may crop
    - `"fill"`: Stretch to fill (may distort)
    - `"none"`: Use natural size
  - `landscape` (boolean): Page orientation. Default: `false`

**Image Limits:**
- Maximum 5MB per image
- Maximum 10MB total payload
- Maximum 10000x10000 pixels per image
- Maximum images per request: Same as page limit per environment (e.g., 2 images in dev, 100 images in prod). Each image = 1 page. If exceeded, request is rejected with `400 PAGE_LIMIT_EXCEEDED` error (no truncation).

### 1.3 Validation Rules (Summary)

1. **Authentication**
   - Either JWT token or API key must be present and valid, or request is rejected with **401** (`UNAUTHORIZED`).
   - If API key is used, it must be active and not revoked.

2. **Account**
   - `Users` record must exist for the `sub`; otherwise **403** (`ACCOUNT_NOT_FOUND`).

3. **Body (HTML/Markdown - JSON)**
   - `input_type` must be `"html"` or `"markdown"`.
   - Exactly one of `html` or `markdown` must be provided (non-empty).
   - Content must match `input_type` (basic starting-tag check).
   - Input size must be ≤ ~5 MB.

4. **Body (Images - Multipart)**
   - `input_type` must be `"image"`.
   - At least one image file must be provided in the `images` field.
   - Each image must be PNG or JPEG format.
   - Each image must be ≤ 5 MB.
   - Total payload must be ≤ 10 MB.
   - Image dimensions must be ≤ 10000x10000 pixels.
   - Image count must not exceed page limit per environment (e.g., 2 images in dev, 100 images in prod). Each image = 1 page. If exceeded, request is rejected with `400 PAGE_LIMIT_EXCEEDED` error before conversion.

5. **Business Logic**
   - **Conversion Type Validation:** The requested `input_type` must be enabled for the user's plan. If the plan has `enabled_conversion_types` configured and the requested type is not in the list, the request is rejected with **403** `CONVERSION_TYPE_NOT_ENABLED` error. If the plan does not have `enabled_conversion_types` configured (or it's `null` or empty), all conversion types are allowed (backward compatible).
   - Free tier:
     - Per-user rate limit: 20 req/min (**403** `RATE_LIMIT_EXCEEDED` on breach).
     - All-time quota: Configurable per plan via `monthly_quota` in `Plans` table (default: 50 PDFs from `FREE_TIER_QUOTA` environment variable) (**403** `QUOTA_EXCEEDED` after that; must upgrade).
   - Paid plan:
     - No quota; still subject to API Gateway throttling.
     - **Credit Check:** Verifies user has sufficient credits (`credits_balance >= price_per_pdf` or `free_credits_remaining > 0`). If insufficient, rejects with **403** `INSUFFICIENT_CREDITS` error.
   - **Page Limit (HTML/Markdown):** Maximum page limit is enforced per environment (e.g., 2 pages in dev, 100 pages in prod). If the generated PDF exceeds this limit, the request is rejected with **400** `PAGE_LIMIT_EXCEEDED` error. No truncation is performed.
   - **Page Limit (Images):** Same maximum page limit as HTML/Markdown (e.g., 2 pages in dev, 100 pages in prod). Each image = 1 page. The image count is checked **before conversion**. If the image count exceeds the page limit, the request is rejected with **400** `PAGE_LIMIT_EXCEEDED` error. No truncation is performed.

### 1.4 Response

#### 1.4.1 Success Response

- **Status:** `200 OK`
- **Headers:**

```http
Content-Type: application/pdf
Content-Disposition: inline; filename="document.pdf"
X-PDF-Pages: 42
X-PDF-Truncated: false
X-Job-Id: 9f0a4b78-2c0c-4d14-9b8b-123456789abc
```

- **Body:** Binary PDF content (up to maximum allowed pages per environment).

**Notes:**
- Maximum page limit is enforced per environment (e.g., 2 pages in dev, 100 pages in prod).
- **For HTML/Markdown:** If the rendered PDF exceeds the maximum page limit, the request is rejected with a `400 Bad Request` error (`PAGE_LIMIT_EXCEEDED`). No truncation is performed.
- **For Images:** The image count is checked **before conversion** (1 image = 1 page). If the image count exceeds the maximum page limit, the request is rejected with a `400 Bad Request` error (`PAGE_LIMIT_EXCEEDED`). No truncation is performed.

#### 1.4.2 Timeout Response

- **Status:** `408 Request Timeout`

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

**Note:** Timeout events are logged in both `JobDetails` and `Analytics` tables with `status: "timeout"` and `timeout_occurred: true`.

#### 1.4.3 Error Responses

Common error statuses:

- `400 Bad Request`
  - Invalid/missing `input_type`
  - Missing/empty content field
  - Both `html` and `markdown` provided
  - Wrong content field for given `input_type`
  - Content type mismatch
  - Input size exceeds limit
  - PDF page count exceeds maximum allowed pages (`PAGE_LIMIT_EXCEEDED`)
  - **Image-specific errors:**
    - `INVALID_IMAGE_FORMAT` - Image is not PNG or JPEG
    - `INVALID_IMAGE_DATA` - Image is corrupted or invalid
    - `IMAGE_TOO_LARGE` - Image exceeds 5MB or 10000x10000 pixels
    - `MISSING_IMAGES` - No image files in multipart request
    - `INVALID_MULTIPART` - Malformed multipart/form-data request
    - `INVALID_OPTIONS_JSON` - Options field is not valid JSON

- `401 Unauthorized`
  - Missing or invalid authentication (neither valid JWT nor API key provided)
  - JWT token is expired, malformed, or not an ID token
  - API key is invalid, revoked, or inactive

- `403 Forbidden`
  - Account not found (`ACCOUNT_NOT_FOUND`)
  - Conversion type not enabled for plan (`CONVERSION_TYPE_NOT_ENABLED`)
  - Per-user rate limit exceeded for free tier (`RATE_LIMIT_EXCEEDED`)
  - Free tier quota exhausted (`QUOTA_EXCEEDED`)

- `408 Request Timeout`
  - Job processing exceeded 30-second timeout

- `429 Too Many Requests`
  - Global API Gateway throttling triggered (from API Gateway, not Lambda).

- `500 Internal Server Error`
  - Unexpected server-side failure (Chromium, Puppeteer, or infrastructure issues).

For full error payload examples and codes, see `ERRORS.md`.

---

## 2. `POST /longjob`

**Description:**  
Asynchronous PDF generation with queueing, S3 storage, and webhook notifications. Use for larger documents or when you need webhook callbacks.

**Note:** Image uploads (multipart/form-data) are **not supported** in `/longjob`. Use `/quickjob` for image-to-PDF conversion - images process fast enough (~0.5-2s per image) to complete within the 30-second timeout.

### 2.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito) **OR** API Key
- **Note:** No API Gateway authorizer is used. Authentication is handled directly in Lambda to support both JWT and API key.
- **Headers (choose one):**

**Option 1: JWT Token (ID Token)**
```http
Authorization: Bearer <id_token>
```

**Option 2: API Key**
```http
X-API-Key: <api_key>
```
or
```http
Authorization: Bearer <api_key>
```

**Requirements:**
- Either a valid JWT token or a valid API key must be provided.
- **JWT Token Requirements:**
  - Must be the **ID token** (not access token) from Cognito `/signin` response
  - Token is verified directly in Lambda against Cognito JWKS (public keys)
  - Validates issuer, audience, expiration, algorithm (RS256), and `token_use: id`
- **API Key Requirements:**
  - API key must be active and not revoked
  - API keys start with `pk_live_` or `pk_test_`
- User account must exist in `Users`.
- **Note:** If both are provided, API key takes precedence.

### 2.2 HTTP Request

**Method:** `POST`  
**Path:** `/longjob`  
**Content-Type:** `application/json`

#### 2.2.1 Request Body (HTML)

```json
{
  "input_type": "html",
  "html": "<!DOCTYPE html><html><head><title>Large Report</title></head><body><h1>Large Report</h1><p>Content...</p></body></html>",
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

#### 2.2.2 Request Body (Markdown)

```json
{
  "input_type": "markdown",
  "markdown": "# Large Report\n\nThis is **markdown** content...",
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

#### 2.2.3 Request Fields

- `input_type` (string, required)
  - Must be `"html"` or `"markdown"`.
- `html` (string, required if `input_type` is `"html"`)
  - Full HTML content to render.
- `markdown` (string, required if `input_type` is `"markdown"`)
  - Markdown content to render (GitHub-flavored).
- `options` (object, optional)
  - Passed to Puppeteer `page.pdf()` (same as quickjob).
- `webhook_url` (string, optional, **ignored**)
  - **Note:** This parameter is ignored. Webhooks are only delivered to webhooks registered via the webhook management API (`POST /accounts/me/webhooks`). See Section 22 for webhook management.

### 2.3 Validation Rules (Summary)

Same validation as `/quickjob` (authentication, account, body, business logic), plus:

- **Conversion Type Validation:** The requested `input_type` must be enabled for the user's plan. If the plan has `enabled_conversion_types` configured and the requested type is not in the list, the request is rejected with **403** `CONVERSION_TYPE_NOT_ENABLED` error. Note: Image conversion type is not supported in `/longjob` (returns `400 Bad Request` before conversion type validation).
- **Credit Check (Paid Plans):** Verifies user has sufficient credits (`credits_balance >= price_per_pdf` or `free_credits_remaining > 0`). If insufficient, rejects with **403** `INSUFFICIENT_CREDITS` error. This check happens before queuing the job.
- **Page Limit Check:** The PDF is generated synchronously before queuing to validate the page count. If the page limit is exceeded, the request is rejected immediately with `400 Bad Request` (`PAGE_LIMIT_EXCEEDED`). The job is only queued if the page limit check passes.
- **Webhook Delivery:** Webhooks are only delivered to webhooks registered via the webhook management API (`POST /accounts/me/webhooks`). The `webhook_url` parameter in the request body is ignored. See Section 22 for webhook management.

### 2.4 Response

#### 2.4.1 Success Response

- **Status:** `202 Accepted`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "queued",
  "message": "Job queued for processing",
  "estimated_completion": "2025-12-21T10:35:00Z"
}
```

**Fields:**
- `job_id` (string): UUID of the job (use this to check status via `GET /jobs/{job_id}`).
- `status` (string): Always `"queued"` on initial response.
- `message` (string): Confirmation message.
- `estimated_completion` (string): ISO 8601 timestamp estimate (may vary based on queue depth).

#### 2.4.2 Error Responses

Same error responses as `/quickjob` (400, 401, 403, 429, 500), plus:
- `400 Bad Request` – PDF page count exceeds maximum allowed pages (`PAGE_LIMIT_EXCEEDED`). **This error is returned immediately before queuing the job.** No job record is created and no webhook will be sent.
- `403 Forbidden` – Conversion type not enabled for plan (`CONVERSION_TYPE_NOT_ENABLED`). **This error is returned before queuing the job.** No job record is created and no webhook will be sent.

**Note:** The page limit is checked synchronously before queuing. If the limit is exceeded, the error is returned immediately in the initial response. If the check passes, the job is queued and processing happens asynchronously. Use `GET /jobs/{job_id}` to check status, or wait for webhook notification (if webhooks are configured via the webhook management API).

---

## 3. `GET /jobs/{job_id}`

**Description:**  
Get status and details of a specific job.

### 3.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.
- Job must belong to the authenticated user.

### 3.2 HTTP Request

**Method:** `GET`  
**Path:** `/jobs/{job_id}`  
**Path Parameters:**
- `job_id` (string, required): UUID of the job.

### 3.3 Response

#### 3.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

**For QuickJob:**
```json
{
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "completed",
  "job_type": "quick",
  "mode": "html",
  "pages": 42,
  "truncated": false,
  "created_at": "2025-12-21T10:30:00Z",
  "completed_at": "2025-12-21T10:30:05Z",
  "timeout_occurred": false,
  "api_key_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "error_message": null
}
```

**For LongJob (Queued):**
```json
{
  "job_id": "8e1b5c89-3d1d-5e25-ac9c-234567890def",
  "status": "queued",
  "job_type": "long",
  "mode": "html",
  "created_at": "2025-12-21T10:30:00Z",
  "completed_at": null,
  "s3_url": null,
  "s3_url_expires_at": null,
  "webhook_delivered": false,
  "error_message": null
}
```

**For LongJob (Completed):**
```json
{
  "job_id": "8e1b5c89-3d1d-5e25-ac9c-234567890def",
  "status": "completed",
  "job_type": "long",
  "mode": "html",
  "pages": 150,
  "truncated": false,
  "created_at": "2025-12-21T10:30:00Z",
  "completed_at": "2025-12-21T10:32:15Z",
  "s3_url": "https://s3.amazonaws.com/podpdf-dev-pdfs/8e1b5c89-3d1d-5e25-ac9c-234567890def.pdf?X-Amz-Signature=...",
  "s3_url_expires_at": "2025-12-21T11:32:15Z",
  "webhook_delivered": true,
  "webhook_delivered_at": "2025-12-21T10:32:20Z",
  "webhook_retry_count": 0,
  "error_message": null
}
```

**For LongJob (Failed):**
```json
{
  "job_id": "8e1b5c89-3d1d-5e25-ac9c-234567890def",
  "status": "failed",
  "job_type": "long",
  "mode": "html",
  "created_at": "2025-12-21T10:30:00Z",
  "completed_at": "2025-12-21T10:32:15Z",
  "error_message": "PDF generation failed: ...",
  "webhook_delivered": false
}
```

**Fields:**
- `job_id` (string): UUID of the job.
- `status` (string): `"queued"`, `"processing"`, `"completed"`, `"failed"`, or `"timeout"` (quick jobs only).
- `job_type` (string): `"quick"` or `"long"`.
- `mode` (string): `"html"`, `"markdown"`, or `"image"`.
- `pages` (number, optional): Number of pages in the returned PDF (present when completed).
- `truncated` (boolean, optional): Always `false` (truncation is no longer performed; requests exceeding page limit are rejected).
- `created_at` (string): ISO 8601 timestamp.
- `completed_at` (string, optional): ISO 8601 timestamp (present when job completes or fails).
- `s3_url` (string, optional): Signed URL for S3 object (long jobs only, 1-hour expiry).
- `s3_url_expires_at` (string, optional): ISO 8601 timestamp when signed URL expires.
- `webhook_delivered` (boolean, optional): Whether webhook was successfully delivered (long jobs only).
- `webhook_delivered_at` (string, optional): ISO 8601 timestamp when webhook was delivered.
- `webhook_retry_count` (number, optional): Number of webhook retry attempts (0-3).
- `timeout_occurred` (boolean, optional): `true` if quick job exceeded 30-second timeout.
- `api_key_id` (string, ULID, optional): The API key ID used for this job. `null` if JWT authentication was used.
- `error_message` (string, optional): Error message if status is `"failed"` or `"timeout"`.

#### 3.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `404 Not Found` – Job not found or doesn't belong to authenticated user.
- `500 Internal Server Error` – Server-side failure.

---

## 3.4 `GET /jobs/{job_id}/webhooks/history`

**Description:**  
Get webhook delivery history for a specific job. Shows all webhook deliveries (across all webhooks) that were triggered for this job.

### 3.4.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired
- User account must exist in `Users` table
- Job must belong to authenticated user

### 3.4.2 HTTP Request

**Method:** `GET`  
**Path:** `/jobs/{job_id}/webhooks/history`

**Path Parameters:**
- `job_id` (string, required) - Job identifier (UUID)

#### 3.4.3 Query Parameters

- `status` (string, optional) - Filter by delivery status
  - Valid values: `success`, `failed`, `timeout`
- `event_type` (string, optional) - Filter by event type
  - Valid values: `job.completed`, `job.failed`, `job.timeout`, `job.queued`, `job.processing`
- `limit` (number, optional) - Maximum results (default: 50, max: 100)
- `next_token` (string, optional) - Pagination token from previous response

### 3.4.4 Response

#### 3.4.4.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "history": [
    {
      "delivery_id": "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      "webhook_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "event_type": "job.completed",
      "status": "success",
      "status_code": 200,
      "retry_count": 0,
      "delivered_at": "2025-12-24T15:30:00Z",
      "duration_ms": 245,
      "payload_size_bytes": 1024,
      "url": "https://api.example.com/webhooks/podpdf"
    },
    {
      "delivery_id": "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      "webhook_id": "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "event_type": "job.completed",
      "status": "failed",
      "status_code": 500,
      "error_message": "HTTP 500",
      "retry_count": 3,
      "delivered_at": "2025-12-24T15:30:05Z",
      "duration_ms": 7500,
      "payload_size_bytes": 1024,
      "url": "https://api.example.com/webhooks/podpdf-staging"
    }
  ],
  "count": 2,
  "next_token": null
}
```

**Fields:**
- `job_id` (string) - Job identifier
- `history` (array) - List of webhook delivery records for this job
  - `delivery_id` (string) - Unique delivery identifier (ULID)
  - `webhook_id` (string) - Webhook ID that was called
  - `event_type` (string) - Event type that triggered webhook
  - `status` (string) - Delivery status: `success`, `failed`, or `timeout`
  - `status_code` (number, optional) - HTTP status code from webhook endpoint
  - `error_message` (string, optional) - Error message if delivery failed
  - `retry_count` (number) - Number of retry attempts (0-3)
  - `delivered_at` (string) - ISO 8601 timestamp when delivery completed
  - `duration_ms` (number) - Total delivery duration in milliseconds
  - `payload_size_bytes` (number) - Size of webhook payload in bytes
  - `url` (string) - Webhook URL that was called (snapshot at time of delivery)
- `count` (number) - Number of history records in this response
- `next_token` (string, optional) - Pagination token for next page (null if last page)

**Note:** History records are kept permanently (no TTL). This provides long-term retention for debugging, auditing, and troubleshooting.

#### 3.4.4.2 Error Responses

- `401 Unauthorized` - Missing or invalid JWT token
- `404 Not Found` - Job not found or doesn't belong to authenticated user
  - Error code: `JOB_NOT_FOUND`
- `500 Internal Server Error` - Server-side failure

---

## 4. `GET /jobs`

**Description:**  
List jobs for the authenticated user (dashboard endpoint).

### 4.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.

### 4.2 HTTP Request

**Method:** `GET`  
**Path:** `/jobs`  
**Query Parameters:**
- `limit` (number, optional): Maximum number of jobs to return. Default: `50`, Max: `100`.
- `next_token` (string, optional): Pagination token from previous response.
- `status` (string, optional): Filter by status. Values: `"queued"`, `"processing"`, `"completed"`, `"failed"`, `"timeout"`, or omit for all.
- `job_type` (string, optional): Filter by job type. Values: `"quick"`, `"long"`, or omit for all.
- `truncated` (boolean, optional): Filter by truncation status. Note: Truncation is no longer performed; this field is kept for backward compatibility and will always be `false` for new jobs. `true` to show only jobs with `truncated: true` (legacy), `false` for non-truncated, omit for all.

### 4.3 Response

#### 4.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "jobs": [
    {
      "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
      "status": "completed",
      "job_type": "quick",
      "mode": "html",
      "pages": 42,
      "truncated": false,
      "created_at": "2025-12-21T10:30:00Z",
      "completed_at": "2025-12-21T10:30:05Z"
    },
    {
      "job_id": "8e1b5c89-3d1d-5e25-ac9c-234567890def",
      "status": "completed",
      "job_type": "long",
      "mode": "markdown",
      "pages": 100,
      "truncated": false,
      "created_at": "2025-12-21T09:15:00Z",
      "completed_at": "2025-12-21T09:15:12Z",
      "s3_url": "https://s3.amazonaws.com/...?X-Amz-Signature=...",
      "s3_url_expires_at": "2025-12-21T10:15:12Z"
    }
  ],
  "next_token": "eyJ1c2VyX3N1YiI6IjEyMzQ1NiIsImNyZWF0ZWRfYXQiOiIyMDI1LTEyLTIxVDA5OjE1OjAwWiJ9",
  "count": 2
}
```

**Fields:**
- `jobs` (array): List of job objects (ordered by `created_at` descending).
- `next_token` (string, optional): Token for pagination if more results exist.
- `count` (number): Number of jobs in this response.

**Job Object Fields:**
- Same fields as `GET /jobs/{job_id}` response, but may be abbreviated for list view.

#### 4.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

---

## 5. `POST /accounts` (Legacy/Manual - Optional)

**Description:**  
⚠️ **Note:** This endpoint is now optional. Account creation is **automatically handled** by the Cognito Post Confirmation Lambda trigger when a user confirms their email.

**Automatic Account Creation (Recommended):**
- When a user signs up via Amplify and confirms their email, Cognito automatically invokes a Lambda function
- The Lambda function creates the DynamoDB account record automatically
- No frontend call needed

**Manual Account Creation (Fallback):**
- If automatic creation fails or you need manual control, you can call this endpoint
- This endpoint creates a new user account record in DynamoDB manually

**Note:** User signup (Cognito user creation) is handled by the frontend using AWS Amplify. Account record creation happens automatically via Lambda trigger after email confirmation.

### 5.1 Authentication

- **Type:** None (public endpoint)
- **Note:** This endpoint does not require authentication. It is typically not needed since account creation is automatic.

### 5.2 HTTP Request

**Method:** `POST`  
**Path:** `/accounts`  
**Content-Type:** `application/json`

#### 5.2.1 Request Body

```json
{
  "user_sub": "12345678-1234-1234-1234-123456789012",
  "email": "user@example.com",
  "name": "John Doe",
  "plan_id": "free-basic"
}
```

**Fields:**
- `user_sub` (string, required): Cognito user identifier (sub claim from JWT token). This is obtained from Amplify after signup.
- `email` (string, required): User's email address.
- `name` (string, optional): User's display name.
- `plan_id` (string, optional): Plan ID to assign. Defaults to `"free-basic"` if not provided.

### 5.3 Response

#### 5.3.1 Success Response

- **Status:** `201 Created`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "user_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "email": "user@example.com",
  "display_name": "John Doe",
  "plan_id": "free-basic",
  "account_status": "free",
  "created_at": "2025-12-21T10:00:00Z"
}
```

**Fields:**
- `user_id` (string): ULID-based primary identifier for the user.
- `email` (string): User's email address (from JWT claims or request body).
- `display_name` (string, optional): User's display name.
- `plan_id` (string): Plan ID assigned to the user.
- `account_status` (string): Account status (`"free"`, `"paid"`, or `"cancelled"`).
- `created_at` (string): ISO 8601 timestamp when account was created.

#### 5.3.2 Error Responses

All error responses follow the standard error format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable error message",
    "details": {}
  }
}
```

**Error Codes:**

- **`400 Bad Request`** – Invalid or missing parameters.
  ```json
  {
    "error": {
      "code": "INVALID_PARAMETER",
      "message": "Invalid user_sub: user_sub field is required",
      "details": {
        "parameter": "user_sub",
        "message": "user_sub field is required"
      }
    }
  }
  ```
  
  Or:
  ```json
  {
    "error": {
      "code": "INVALID_PARAMETER",
      "message": "Invalid email: email field is required",
      "details": {
        "parameter": "email",
        "message": "email field is required"
      }
    }
  }
  ```

  Or for invalid JSON:
  ```json
  {
    "error": {
      "code": "INVALID_PARAMETER",
      "message": "Invalid body: Invalid JSON in request body",
      "details": {
        "parameter": "body",
        "message": "Invalid JSON in request body"
      }
    }
  }
  ```

- **`409 Conflict`** – Account already exists.
  ```json
  {
    "error": {
      "code": "ACCOUNT_ALREADY_EXISTS",
      "message": "Account already exists for this user",
      "details": {
        "action_required": "use_existing_account"
      }
    }
  }
  ```

- **`500 Internal Server Error`** – Server-side failure.
  ```json
  {
    "error": {
      "code": "INTERNAL_SERVER_ERROR",
      "message": "An unexpected error occurred",
      "details": {
        "action_required": "retry_later"
      }
    }
  }
  ```

### 5.4 Sample Request

```bash
curl -X POST https://api.example.com/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "user_sub": "12345678-1234-1234-1234-123456789012",
    "email": "user@example.com",
    "name": "John Doe",
    "plan_id": "free-basic"
  }'
```

**Note:** The `user_sub` and `email` are typically obtained from the Amplify Auth response after signup. The frontend should extract these values and include them in the request.

### 5.5 Sample Response

**Success (201 Created):**
```json
{
  "user_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "email": "user@example.com",
  "display_name": "John Doe",
  "plan_id": "free-basic",
  "account_status": "free",
  "created_at": "2025-12-21T10:00:00Z"
}
```

**Error - Account Already Exists (409 Conflict):**
```json
{
  "error": {
    "code": "ACCOUNT_ALREADY_EXISTS",
    "message": "Account already exists for this user",
    "details": {
      "action_required": "use_existing_account"
    }
  }
}
```

---

## 6. `GET /plans` and `GET /plans/{plan_id}`

**Description:**  
Get plan details. Use `GET /plans` to list all active plans, or `GET /plans/{plan_id}` to get details for a specific plan.

### 6.1 Authentication

- **Type:** None (public endpoint)
- **Note:** This endpoint does not require authentication. Plan details are public information.

### 6.2 HTTP Request

**Method:** `GET`  
**Path:** `/plans` or `/plans/{plan_id}`  
**Path Parameters (for specific plan):**
- `plan_id` (string, required) - Plan identifier (e.g., `"free-basic"`, `"paid-standard"`)

### 6.3 Response

#### 6.3.1 Success Response - List All Plans (200 OK)

```json
{
  "plans": [
    {
      "plan_id": "free-basic",
      "name": "Free Basic",
      "type": "free",
      "monthly_quota": 50,
      "price_per_pdf": 0,
      "rate_limit_per_minute": 20,
      "enabled_conversion_types": ["html"],
      "description": "Free tier with 50 PDFs all-time quota (not monthly - cumulative, does not reset). Rate limit: 20 requests per minute.",
      "is_active": true
    },
    {
      "plan_id": "paid-standard",
      "name": "Paid Standard",
      "type": "paid",
      "monthly_quota": null,
      "price_per_pdf": 0.01,
      "rate_limit_per_minute": null,
      "enabled_conversion_types": ["html", "markdown"],
      "max_webhooks": 5,
      "description": "Paid plan with unlimited PDFs. Price: $0.01 per PDF. Unlimited rate limit.",
      "is_active": true
    }
  ],
  "count": 2
}
```

**Fields:**
- `plans` (array) - List of active plans, sorted by type (free first) then by name
- `count` (number) - Number of active plans returned

**Plan Object Fields:**
- `plan_id` (string) - Unique plan identifier
- `name` (string) - Human-readable plan name
- `type` (string) - Plan type: `"free"` or `"paid"`
- `monthly_quota` (number|null) - Number of PDFs included per month for free plans, `null` for unlimited paid plans
- `price_per_pdf` (number) - Price per PDF in USD (0 for free plans)
- `rate_limit_per_minute` (number|null) - Per-user rate limit in requests per minute, `null` for unlimited
- `enabled_conversion_types` (array|null) - List of conversion types enabled for this plan. Valid values: `"html"`, `"markdown"`, `"image"`. If `null` or not specified, all conversion types are enabled (backward compatible).
- `max_webhooks` (number|null) - Maximum number of webhooks allowed for this plan. Defaults to `1` for free plans and `5` for paid plans if not specified. `null` indicates unlimited (for enterprise plans).
- `description` (string|null) - Plan description
- `is_active` (boolean) - Whether the plan is active and available

#### 6.3.2 Success Response - Get Specific Plan (200 OK)

```json
{
  "plan": {
    "plan_id": "free-basic",
    "name": "Free Basic",
    "type": "free",
    "monthly_quota": 50,
    "price_per_pdf": 0,
    "rate_limit_per_minute": 20,
    "enabled_conversion_types": ["html"],
    "max_webhooks": 1,
    "description": "Free tier with 50 PDFs all-time quota (not monthly - cumulative, does not reset). Rate limit: 20 requests per minute.",
    "is_active": true
  }
}
```

**Fields:**
- `plan` (object) - Plan details (same structure as plan objects in list response)

#### 6.3.3 Error Responses

**404 Not Found - Plan Not Found**
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Plan not found: invalid-plan-id",
    "details": {
      "action_required": "check_resource_id"
    }
  }
}
```

**500 Internal Server Error**
```json
{
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "An unexpected error occurred",
    "details": {
      "action_required": "retry_later"
    }
  }
}
```

### 6.4 Example Requests

**List All Plans:**
```bash
curl -X GET https://api.podpdf.com/plans
```

**Get Specific Plan:**
```bash
curl -X GET https://api.podpdf.com/plans/free-basic
```

### 6.5 Example Responses

**List All Plans:**
```json
{
  "plans": [
    {
      "plan_id": "free-basic",
      "name": "Free Basic",
      "type": "free",
      "monthly_quota": 50,
      "price_per_pdf": 0,
      "rate_limit_per_minute": 20,
      "enabled_conversion_types": ["html"],
      "max_webhooks": 1,
      "description": "Free tier with 50 PDFs all-time quota (not monthly - cumulative, does not reset). Rate limit: 20 requests per minute.",
      "is_active": true
    },
    {
      "plan_id": "paid-standard",
      "name": "Paid Standard",
      "type": "paid",
      "monthly_quota": null,
      "price_per_pdf": 0.01,
      "rate_limit_per_minute": null,
      "enabled_conversion_types": ["html", "markdown"],
      "max_webhooks": 5,
      "description": "Paid plan with unlimited PDFs. Price: $0.01 per PDF. Unlimited rate limit.",
      "is_active": true
    }
  ],
  "count": 2
}
```

**Get Specific Plan:**
```json
{
  "plan": {
    "plan_id": "paid-standard",
    "name": "Paid Standard",
    "type": "paid",
    "monthly_quota": null,
    "price_per_pdf": 0.01,
    "rate_limit_per_minute": null,
    "enabled_conversion_types": ["html", "markdown"],
    "max_webhooks": 5,
    "description": "Paid plan with unlimited PDFs. Price: $0.01 per PDF. Unlimited rate limit.",
    "is_active": true
  }
}
```

### 6.6 Usage Notes

- **Public Endpoint:** This endpoint does not require authentication. Plan details are public information useful for displaying pricing and features in the frontend.
- **Active Plans Only:** The list endpoint (`GET /plans`) only returns plans where `is_active` is `true` (or not set, which defaults to `true`).
- **Sorting:** Plans are sorted by type (free plans first) then alphabetically by name.
- **Null Values:** Some fields may be `null`:
  - `monthly_quota`: `null` for paid plans (unlimited)
  - `rate_limit_per_minute`: `null` for paid plans (unlimited) or plans without rate limits
  - `max_webhooks`: `null` for enterprise plans (unlimited), defaults to `1` for free and `5` for paid if not specified
  - `description`: `null` if no description is set
- **Plan Types:**
  - `"free"`: Free tier plans with quota limits
  - `"paid"`: Paid plans with per-PDF pricing

**Status Codes:**
- `200 OK` – Success
- `404 Not Found` – Plan not found (for specific plan endpoint)
- `500 Internal Server Error` – Server-side failure

---

## 8. `GET /accounts/me`

**Description:**  
Get information about the authenticated user's account.

### 6.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.

### 8.2 HTTP Request

**Method:** `GET`  
**Path:** `/accounts/me`

### 6.3 Response

#### 6.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "user_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "user_sub": "12345678-1234-1234-1234-123456789012",
  "email": "user@example.com",
  "display_name": "John Doe",
  "plan_id": "free-basic",
  "account_status": "free",
  "total_pdf_count": 42,
  "quota_exceeded": false,
  "webhook_url": "https://example.com/webhook",
  "created_at": "2025-12-21T10:00:00Z",
  "upgraded_at": null,
  "plan": {
    "plan_id": "free-basic",
    "name": "Free Basic",
    "type": "free",
    "monthly_quota": 50,
    "price_per_pdf": 0,
    "rate_limit_per_minute": 20
  }
}
```

**Fields:**
- `user_id` (string): ULID-based primary identifier for the user.
- `user_sub` (string): User identifier from Cognito (for authentication).
- `email` (string): User's email address.
- `display_name` (string, optional): User's display name.
- `plan_id` (string): Current plan ID.
- `account_status` (string): `"free"` or `"paid"`.
- `total_pdf_count` (number): All-time PDF count for the user.
- `quota_exceeded` (boolean): `true` if free tier user has exceeded their plan's quota limit (from `plan.monthly_quota` in `Plans` table), `false` otherwise. Frontend should show a banner when this is `true`.
- `webhook_url` (string, optional): User's default webhook URL for long job notifications.
- `created_at` (string): ISO 8601 timestamp.
- `upgraded_at` (string, optional): ISO 8601 timestamp when upgraded to paid plan.
- `plan` (object): Full plan configuration from `Plans` table.

#### 6.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

---

## 9. `GET /accounts/me/billing`

**Description:**  
Get billing summary for the authenticated user. Returns credit balance, all-time PDF count, and calculated total amount based on plan pricing.

**Note:** This endpoint uses direct reads from the `Users` table for fast, reliable data access. Credit purchase history is available via `CreditTransactions` table queries.

### 7.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.

### 7.2 HTTP Request

**Method:** `GET`  
**Path:** `/accounts/me/billing`

### 7.3 Response

#### 7.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

**For Paid Plan Users:**
```json
{
  "billing": {
    "plan_id": "paid-standard",
    "plan_type": "paid",
    "credits_balance": 10.50,
    "free_credits_remaining": 5,
    "total_pdf_count": 25,
    "total_amount": 0.25,
    "price_per_pdf": 0.01
  }
}
```

**For Free Plan Users:**
```json
{
  "billing": {
    "plan_id": "free-basic",
    "plan_type": "free",
    "credits_balance": 0,
    "free_credits_remaining": null,
    "total_pdf_count": 42,
    "total_amount": 0,
    "price_per_pdf": 0
  }
}
```

**Fields:**
- `plan_id` (string): Current plan ID.
- `plan_type` (string): `"free"` or `"paid"`.
- `credits_balance` (number): Prepaid credit balance in USD. `0` for free plan users.
- `free_credits_remaining` (number|null): Remaining free PDF credits. `null` if plan has no free credits.
- `total_pdf_count` (number): All-time PDF count (cumulative total since account creation, does not reset).
- `total_amount` (number): Calculated as `total_pdf_count × price_per_pdf`. `0` for free plan users.
- `price_per_pdf` (number): Price per PDF from the plan configuration. `0` for free plan users.

#### 7.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

### 7.4 Example Request

```bash
curl -X GET https://api.podpdf.com/accounts/me/billing \
  -H "Authorization: Bearer <jwt_token>"
```

### 7.5 Example Response

**Paid Plan User:**
```json
{
  "billing": {
    "plan_id": "paid-standard",
    "plan_type": "paid",
    "credits_balance": 10.50,
    "free_credits_remaining": 5,
    "total_pdf_count": 25,
    "total_amount": 0.25,
    "price_per_pdf": 0.01
  }
}
```

**Free Plan User:**
```json
{
  "billing": {
    "plan_id": "free-basic",
    "plan_type": "free",
    "credits_balance": 0,
    "free_credits_remaining": null,
    "total_pdf_count": 42,
    "total_amount": 0,
    "price_per_pdf": 0
  }
}
```

### 7.6 Usage Notes

- **Data Source:** All data is read directly from the `Users` table for fast, reliable access. No expensive queries or aggregations are performed.
- **PDF Count:** `total_pdf_count` shows the **all-time total** (cumulative since account creation, does not reset) for both free and paid users. Updated atomically by the credit deduction processor.
- **Credit Balance:** `credits_balance` shows the current prepaid credit balance. Users purchase credits upfront, and credits are deducted after each PDF generation.
- **Free Credits:** `free_credits_remaining` shows remaining free PDF credits (consumed before prepaid credits). `null` if the plan has no free credits.
- **Total Amount Calculation:** `total_amount = total_pdf_count × price_per_pdf`. This represents the total value of PDFs generated (for informational purposes). `0` for free plan users.
- **Credit Transactions:** All credit purchases and deductions are logged in the `CreditTransactions` table for audit trail and history queries.

---

## 10. `GET /accounts/me/bills`

**Description:**  
Get a list of all bills/invoices for the authenticated user. Returns all monthly billing records (both active and inactive) sorted by month (most recent first). All bill history is preserved in the same table, with the `is_active` field indicating whether a bill is for the current month.

### 8.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.

### 8.2 HTTP Request

**Method:** `GET`  
**Path:** `/accounts/me/bills`

### 8.3 Response

#### 8.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

**For Paid Plan Users:**
```json
{
  "plan_id": "paid-standard",
  "plan_type": "paid",
  "bills": [
    {
      "billing_month": "2025-12",
      "monthly_pdf_count": 25,
      "monthly_billing_amount": 0.125,
      "is_paid": false,
      "is_active": true,
      "bill_id": null,
      "invoice_id": null,
      "paid_at": null,
      "created_at": "2025-12-01T10:00:00Z",
      "updated_at": "2025-12-24T15:30:00Z"
    },
    {
      "billing_month": "2025-11",
      "monthly_pdf_count": 150,
      "monthly_billing_amount": 0.75,
      "is_paid": true,
      "is_active": false,
      "bill_id": "bill_abc123",
      "invoice_id": "inv_xyz789",
      "paid_at": "2025-12-05T14:20:00Z",
      "created_at": "2025-11-01T10:00:00Z",
      "updated_at": "2025-12-05T14:20:00Z"
    },
    {
      "billing_month": "2025-10",
      "monthly_pdf_count": 80,
      "monthly_billing_amount": 0.40,
      "is_paid": true,
      "is_active": false,
      "bill_id": "bill_def456",
      "invoice_id": "inv_uvw012",
      "paid_at": "2025-11-03T09:15:00Z",
      "created_at": "2025-10-01T10:00:00Z",
      "updated_at": "2025-11-03T09:15:00Z"
    }
  ]
}
```

**For Free Plan Users:**
```json
{
  "plan_id": "free-basic",
  "plan_type": "free",
  "bills": []
}
```

**Fields:**
- `plan_id` (string): Current plan ID.
- `plan_type` (string): `"free"` or `"paid"`.
- `bills` (array): List of bill records, sorted by `billing_month` descending (most recent first).
  - `billing_month` (string): Billing month in `YYYY-MM` format.
  - `monthly_pdf_count` (number): Number of PDFs generated in this month.
  - `monthly_billing_amount` (number): Total amount for this month in USD.
  - `is_paid` (boolean): Whether the bill has been paid.
  - `is_active` (boolean): Whether this bill is for the current month (`true`) or a previous month (`false`). Bills are marked as inactive when a new month begins.
  - `bill_id` (string, optional): External bill ID (e.g., from payment processor).
  - `invoice_id` (string, optional): Invoice ID from payment processor.
  - `paid_at` (string, optional): ISO 8601 timestamp when bill was marked as paid.
  - `created_at` (string): ISO 8601 timestamp when bill record was created.
  - `updated_at` (string): ISO 8601 timestamp when bill record was last updated.

#### 8.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

### 8.4 Example Request

```bash
curl -X GET https://api.podpdf.com/accounts/me/bills \
  -H "Authorization: Bearer <jwt_token>"
```

### 8.5 Example Response

```json
{
  "plan_id": "paid-standard",
  "plan_type": "paid",
  "bills": [
    {
      "billing_month": "2025-12",
      "monthly_pdf_count": 25,
      "monthly_billing_amount": 0.125,
      "is_paid": false,
      "is_active": true,
      "bill_id": null,
      "invoice_id": null,
      "paid_at": null,
      "created_at": "2025-12-01T10:00:00Z",
      "updated_at": "2025-12-24T15:30:00Z"
    },
    {
      "billing_month": "2025-11",
      "monthly_pdf_count": 150,
      "monthly_billing_amount": 0.75,
      "is_paid": true,
      "is_active": false,
      "bill_id": "bill_abc123",
      "invoice_id": "inv_xyz789",
      "paid_at": "2025-12-05T14:20:00Z",
      "created_at": "2025-11-01T10:00:00Z",
      "updated_at": "2025-12-05T14:20:00Z"
    }
  ]
}
```

### 8.6 Usage Notes

- **Sorting:** Bills are sorted by `billing_month` in descending order (most recent first).
- **Free Plan Users:** Free plan users will always receive an empty `bills` array.
- **Bill Creation:** Bill records are automatically created when a paid user generates their first PDF of a month.
- **Payment Status:** The `is_paid` flag can be updated when payment is processed (e.g., via Paddle webhook).
- **Historical Records:** All bills (both active and inactive) are returned and preserved in the same table for invoicing and accounting purposes. The `is_active` field indicates whether a bill is for the current month (`true`) or a previous month (`false`).
- **Bill Updates:** Bills for the same month are updated in place (counts and amounts are incremented). When a new month begins, previous month bills are marked as `is_active = false` and a new bill is created for the current month.

---

## 11. `GET /accounts/me/stats`

**Description:**  
Get total PDF count, monthly PDF count, and total amount for the authenticated user. For free plans, returns all-time PDF count from the Users table and current month's PDF count from the Bills table. For paid plans, returns current month's PDF count and billing amount from the Bills table.

### 11.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.

### 11.2 HTTP Request

**Method:** `GET`  
**Path:** `/accounts/me/stats`

### 11.3 Response

#### 11.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

**For Paid Plan Users:**
```json
{
  "stats": {
    "plan_id": "paid-standard",
    "plan_type": "paid",
    "total_pdf_count": 25,
    "total_pdf_count_month": 25,
    "total_amount": 0.125
  }
}
```

**For Free Plan Users:**
```json
{
  "stats": {
    "plan_id": "free-basic",
    "plan_type": "free",
    "total_pdf_count": 42,
    "total_pdf_count_month": 5,
    "total_amount": 0
  }
}
```

**Fields:**
- `plan_id` (string): Current plan ID.
- `plan_type` (string): `"free"` or `"paid"`.
- `total_pdf_count` (number): 
  - **For free plan users:** All-time PDF count from Users table (cumulative total since account creation, does not reset).
  - **For paid plan users:** Current month's PDF count from Bills table (resets each month).
- `total_pdf_count_month` (number): Current month's PDF count from Bills table for the current month. `0` if no bill record exists for the current month. This field is available for both free and paid plan users.
- `total_amount` (number): 
  - **For free plan users:** Always `0` (free plans have no billing).
  - **For paid plan users:** Current month's billing amount in USD from Bills table. `0` if no bill exists for current month.

#### 11.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

### 11.4 Example Request

```bash
curl -X GET https://api.podpdf.com/accounts/me/stats \
  -H "Authorization: Bearer <jwt_token>"
```

### 11.5 Example Response

**Paid Plan User:**
```json
{
  "stats": {
    "plan_id": "paid-standard",
    "plan_type": "paid",
    "total_pdf_count": 25,
    "total_pdf_count_month": 25,
    "total_amount": 0.125
  }
}
```

**Free Plan User:**
```json
{
  "stats": {
    "plan_id": "free-basic",
    "plan_type": "free",
    "total_pdf_count": 42,
    "total_pdf_count_month": 5,
    "total_amount": 0
  }
}
```

### 11.6 Usage Notes

- **PDF Count Behavior:**
  - **Free Plan Users:** 
    - `total_pdf_count` shows the **all-time total** from the Users table (cumulative since account creation, does not reset).
    - `total_pdf_count_month` shows the **current month's count** from the Bills table (resets each month). Returns `0` if no bill record exists for the current month.
  - **Paid Plan Users:** 
    - `total_pdf_count` shows the **current month's count only** from the Bills table (resets each month).
    - `total_pdf_count_month` shows the **current month's count** from the Bills table (same as `total_pdf_count` for paid users). Returns `0` if no bill record exists for the current month.
- **Amount Behavior:**
  - **Free Plan Users:** `total_amount` is always `0` (free plans have no billing).
  - **Paid Plan Users:** `total_amount` shows the current month's billing amount from the Bills table. Returns `0` if no bill record exists for the current month (e.g., new month with no PDFs generated yet).
- **Data Source:**
  - Free plans: `total_pdf_count` comes from `Users.total_pdf_count`, `total_pdf_count_month` comes from `Bills.monthly_pdf_count` for the current month.
  - Paid plans: Both `total_pdf_count` and `total_pdf_count_month` come from `Bills.monthly_pdf_count` for the current month, and `total_amount` comes from `Bills.monthly_billing_amount` for the current month.
- **Current Month:** The current month is calculated as `YYYY-MM` format (e.g., `"2025-12"` for December 2025). Both free and paid plan users can see their current month's PDF count via `total_pdf_count_month`.

---

## 12. `PUT /accounts/me/upgrade` ⚠️ DEPRECATED

**Status:** ⚠️ **DEPRECATED** - This endpoint is deprecated and will be removed in a future version.

**Description:**  
Upgrade a user account from free tier to a paid plan. This endpoint clears the `quota_exceeded` flag and updates the user's plan.

**⚠️ Deprecation Notice:**
This endpoint is deprecated. Users are now automatically upgraded to the `paid-standard` plan when they purchase credits via `POST /accounts/me/credits/purchase`. No separate upgrade call is needed. The upgrade happens atomically with the credit purchase.

**Migration:** Use `POST /accounts/me/credits/purchase` instead. The upgrade will happen automatically when purchasing credits.

### 9.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users` table.

### 12.2 HTTP Request

**Method:** `PUT`  
**Path:** `/accounts/me/upgrade`  
**Content-Type:** `application/json`

#### 12.2.1 Request Body

```json
{
  "plan_id": "paid-standard"
}
```

**Fields:**
- `plan_id` (string, required): The ID of the paid plan to upgrade to (e.g., `"paid-standard"`).

### 12.3 Response

#### 12.3.1 Success Response

**Status Code:** `200 OK`

```json
{
  "message": "Account upgraded successfully",
  "plan": {
    "plan_id": "paid-standard",
    "name": "Paid Standard",
    "type": "paid",
    "price_per_pdf": 0.01
  },
  "upgraded_at": "2025-12-24T15:30:00Z"
}
```

**Fields:**
- `message` (string): Success message.
- `plan` (object): Details of the plan the user was upgraded to.
  - `plan_id` (string): Plan identifier.
  - `name` (string): Plan display name.
  - `type` (string): Plan type (`"paid"`).
  - `price_per_pdf` (number): Price per PDF in USD.
- `upgraded_at` (string): ISO 8601 timestamp when the upgrade occurred.

#### 12.3.2 Error Responses

**400 Bad Request - Invalid Plan ID:**
```json
{
  "error": {
    "code": "INVALID_PLAN_ID",
    "message": "Invalid plan_id: invalid-plan",
    "details": {
      "provided": "invalid-plan",
      "reason": "Plan not found or invalid"
    }
  }
}
```

**400 Bad Request - Plan Must Be Paid:**
```json
{
  "error": {
    "code": "INVALID_PLAN_ID",
    "message": "Plan must be a paid plan",
    "details": {
      "provided": "free-basic",
      "reason": "Plan must be a paid plan"
    }
  }
}
```

**400 Bad Request - Plan Not Active:**
```json
{
  "error": {
    "code": "INVALID_PLAN_ID",
    "message": "Plan is not active",
    "details": {
      "provided": "paid-standard",
      "reason": "Plan is not active"
    }
  }
}
```

**403 Forbidden - Account Not Found:**
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

**500 Internal Server Error:**
```json
{
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "Failed to upgrade account",
    "details": {
      "action_required": "retry_later"
    }
  }
}
```

### 12.4 Example Request

```bash
curl -X PUT https://api.podpdf.com/accounts/me/upgrade \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "plan_id": "paid-standard"
  }'
```

### 12.5 Example Response

```json
{
  "message": "Account upgraded successfully",
  "plan": {
    "plan_id": "paid-standard",
    "name": "Paid Standard",
    "type": "paid",
    "price_per_pdf": 0.01
  },
  "upgraded_at": "2025-12-24T15:30:00Z"
}
```

### 12.6 Usage Notes

- **Plan Validation:** The endpoint validates that:
  - The plan exists in the `Plans` table.
  - The plan is a paid plan (`type: "paid"`).
  - The plan is active (`is_active: true`).
- **Quota Exceeded Flag:** When a user upgrades, the `quota_exceeded` flag is automatically cleared.
- **Account Status:** The user's `account_status` is updated to `"paid"`.
- **Upgrade Timestamp:** The `upgraded_at` timestamp is set to the current time.
- **Future PDFs:** After upgrade, all future PDFs will be billed according to the plan's `price_per_pdf`.
- **Billing:** Monthly billing records will be created in the `Bills` table for all PDFs generated after the upgrade.

---

## 13. `POST /accounts/me/credits/purchase`

**Description:**  
Purchase credits to add to the user's credit balance. Credits are used to pay for PDF generation on paid plans. The purchase is atomically processed and logged to the `CreditTransactions` table for audit purposes.

**Automatic Plan Upgrade:** If the user is on a free plan, they will be automatically upgraded to the `paid-standard` plan when purchasing credits for the first time. This upgrade happens atomically with the credit purchase.

### 13.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users` table.

### 13.2 HTTP Request

**Method:** `POST`  
**Path:** `/accounts/me/credits/purchase`  
**Content-Type:** `application/json`

#### 13.2.1 Request Body

```json
{
  "amount": 10.50
}
```

**Fields:**
- `amount` (number, required): The amount of credits to purchase. Must be a positive number (e.g., `10.50` for $10.50 in credits).

**Validation Rules:**
- `amount` must be a number.
- `amount` must be greater than 0.
- `amount` can be a decimal (e.g., `0.01`, `10.50`, `100.00`).

### 13.3 Response

#### 13.3.1 Success Response

**Status Code:** `200 OK`

**For users already on a paid plan:**
```json
{
  "message": "Credits purchased successfully",
  "credits_balance": 25.50,
  "amount_purchased": 10.50,
  "transaction_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "purchased_at": "2025-12-24T15:30:00.000Z"
}
```

**For users upgraded from free to paid plan:**
```json
{
  "message": "Credits purchased successfully. Account upgraded to paid plan.",
  "credits_balance": 10.50,
  "amount_purchased": 10.50,
  "transaction_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "purchased_at": "2025-12-24T15:30:00.000Z",
  "upgraded": true,
  "plan": {
    "plan_id": "paid-standard",
    "name": "Paid Standard",
    "type": "paid",
    "price_per_pdf": 0.01,
    "free_credits": 0
  },
  "upgraded_at": "2025-12-24T15:30:00.000Z"
}
```

**Fields:**
- `message` (string): Success message. Includes upgrade notification if user was upgraded.
- `credits_balance` (number): The user's updated credit balance after the purchase.
- `amount_purchased` (number): The amount of credits that were purchased.
- `transaction_id` (string): Unique transaction ID (ULID) for this purchase. Can be used to query the `CreditTransactions` table.
- `purchased_at` (string): ISO 8601 timestamp of when the purchase was processed.
- `upgraded` (boolean, optional): Present and `true` if the user was automatically upgraded from free to paid plan.
- `plan` (object, optional): Plan details if the user was upgraded. Contains:
  - `plan_id` (string): Plan identifier (e.g., `"paid-standard"`).
  - `name` (string): Plan display name.
  - `type` (string): Plan type (`"paid"`).
  - `price_per_pdf` (number): Price per PDF in USD.
  - `free_credits` (number): Number of free credits included with the plan.
- `upgraded_at` (string, optional): ISO 8601 timestamp when the upgrade occurred (only present if `upgraded` is `true`).

#### 13.3.2 Error Responses

**400 Bad Request - Invalid Amount:**
```json
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "Amount must be a positive number",
    "details": {
      "parameter": "amount"
    }
  }
}
```

**400 Bad Request - Invalid JSON:**
```json
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "Invalid JSON in request body",
    "details": {
      "parameter": "body"
    }
  }
}
```

**401 Unauthorized - Missing Token:**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or invalid JWT token"
  }
}
```

**403 Forbidden - Account Not Found:**
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

**500 Internal Server Error:**
```json
{
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "Failed to purchase credits",
    "details": {
      "action_required": "retry_later"
    }
  }
}
```

### 13.4 Example Request

```bash
curl -X POST https://api.podpdf.com/accounts/me/credits/purchase \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 10.50
  }'
```

### 13.5 Example Response

**For users already on a paid plan:**
```json
{
  "message": "Credits purchased successfully",
  "credits_balance": 25.50,
  "amount_purchased": 10.50,
  "transaction_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "purchased_at": "2025-12-24T15:30:00.000Z"
}
```

**For users upgraded from free to paid plan:**
```json
{
  "message": "Credits purchased successfully. Account upgraded to paid plan.",
  "credits_balance": 10.50,
  "amount_purchased": 10.50,
  "transaction_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "purchased_at": "2025-12-24T15:30:00.000Z",
  "upgraded": true,
  "plan": {
    "plan_id": "paid-standard",
    "name": "Paid Standard",
    "type": "paid",
    "price_per_pdf": 0.01,
    "free_credits": 0
  },
  "upgraded_at": "2025-12-24T15:30:00.000Z"
}
```

### 13.6 Usage Notes

- **Atomic Operation:** The credit purchase is processed atomically - the user's balance is updated and the transaction is logged in a single operation.
- **Automatic Plan Upgrade:** If the user is on a free plan, they are automatically upgraded to the `paid-standard` plan when purchasing credits. This upgrade:
  - Happens atomically with the credit purchase
  - Sets `account_status` to `"paid"`
  - Clears the `quota_exceeded` flag
  - Sets the `upgraded_at` timestamp
  - Grants any free credits included with the paid plan
  - No separate upgrade endpoint call is needed
- **Transaction Logging:** All credit purchases are logged to the `CreditTransactions` table with:
  - `transaction_type: "purchase"`
  - `status: "completed"`
  - `amount: <positive number>` (the amount purchased)
- **Credit Balance:** The `credits_balance` field in the `Users` table is atomically incremented using DynamoDB's `if_not_exists` to handle users who don't have a balance yet.
- **Transaction History:** You can query the `CreditTransactions` table using the `UserIdIndex` GSI to retrieve a user's complete purchase and deduction history.
- **Idempotency:** Each purchase generates a unique `transaction_id` (ULID). If you need idempotency for payment processing, you should implement it at the payment gateway level before calling this endpoint.
- **Credit Usage:** Credits are automatically deducted when PDFs are generated on paid plans. See the credit-based billing documentation for details.

---

## 14. `PUT /accounts/me/webhook` ⚠️ DEPRECATED

**Status:** ⚠️ **DEPRECATED** - This endpoint is deprecated and will be removed in a future version.

**Description:**  
Configure user's default webhook URL for long job notifications.

**⚠️ Deprecation Notice:**
- This endpoint is **deprecated** and will be removed on **January 1, 2026**
- Please migrate to the new **Multiple Webhooks System** (see Section 22)
- The new system provides enhanced features:
  - Multiple webhooks per user (plan-based limits)
  - Event-based subscriptions (subscribe only to events you care about)
  - Delivery history and statistics tracking
  - Webhook activation/deactivation

**Migration Path:**
- Instead of `PUT /accounts/me/webhook`, use:
  - `POST /accounts/me/webhooks` - Create a new webhook
  - `PUT /accounts/me/webhooks/{webhook_id}` - Update a webhook
- See Section 22 for complete documentation on the new webhook management API

**Deprecation Headers:**
All responses include:
- `Deprecation: true` - Indicates this endpoint is deprecated
- `Sunset: Mon, 01 Jan 2026 00:00:00 GMT` - Removal date
- `Link: </accounts/me/webhooks>; rel="successor-version"` - Link to replacement endpoint

### 10.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.

### 10.2 HTTP Request

**Method:** `PUT`  
**Path:** `/accounts/me/webhook`  
**Content-Type:** `application/json`

#### 10.2.1 Request Body

```json
{
  "webhook_url": "https://example.com/webhook"
}
```

**Fields:**
- `webhook_url` (string, required): HTTPS URL to receive webhook notifications for long jobs.
  - Must be a valid HTTPS URL.
  - Can be set to `null` to remove webhook configuration.

### 7.3 Response

#### 7.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "user_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "webhook_url": "https://example.com/webhook",
  "updated_at": "2025-12-21T10:00:00Z"
}
```

**Fields:**
- `user_id` (string): User ID.
- `webhook_url` (string, optional): Updated webhook URL (or `null` if removed).
- `updated_at` (string): ISO 8601 timestamp when webhook was updated.

#### 7.3.2 Error Responses

- `400 Bad Request` – Invalid `webhook_url` (not HTTPS or malformed URL).
- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

**⚠️ Deprecation Response Fields:**
The response includes additional fields indicating deprecation:
- `_deprecated` (boolean) - Always `true` for this endpoint
- `_deprecation_message` (string) - Message explaining the deprecation
- `_migration_guide` (string) - Link to migration documentation

**Note:** This sets the default webhook URL for all long jobs. You can override it per-job by providing `webhook_url` in the `POST /longjob` request body.

**⚠️ Important:** This endpoint will stop working on January 1, 2026. Please migrate to the new webhook management system before this date.

---

## 15. `DELETE /accounts/me`

**Description:**  
Delete the authenticated user's account and all associated data.

### 11.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.

### 11.2 HTTP Request

**Method:** `DELETE`  
**Path:** `/accounts/me`

### 11.3 Response

#### 11.3.1 Success Response

- **Status:** `204 No Content`
- **Body:** Empty

**Note:** This permanently deletes:
- User account from `Users` table
- All job records from `JobDetails` table (via `user_sub`)
- All rate limit records from `UserRateLimits` table (via `user_sub`)
- Analytics records are not deleted (they don't contain user information)

#### 8.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

---

## 16. API Key Management

The following endpoints allow users to create, list, and revoke API keys for programmatic access to the `/quickjob` and `/longjob` endpoints.

**Important:** All API key management endpoints require JWT authentication (not API key). This prevents API key self-revocation loops and ensures only authenticated users can manage their keys.

---

### 15.1 `POST /accounts/me/api-keys`

**Description:**  
Create a new API key for the authenticated user. The full API key is returned only once on creation. Store it securely as it cannot be retrieved again.

#### 15.1.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito) - **Required**
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.
- **Note:** API keys cannot be used to authenticate to this endpoint.

#### 15.1.2 HTTP Request

**Method:** `POST`  
**Path:** `/accounts/me/api-keys`  
**Content-Type:** `application/json`

**Request Body:**
```json
{
  "name": "Production API Key"
}
```

**Fields:**
- `name` (string, optional): A descriptive name for the API key (e.g., "Production", "Development", "Mobile App"). If not provided, defaults to `null`.

#### 15.1.3 Response

**Success Response (201 Created):**
```json
{
  "api_key": "pk_live_abc123xyz...",
  "api_key_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "name": "Production API Key",
  "created_at": "2025-12-21T10:00:00Z",
  "message": "API key created successfully. Store this key securely - it will not be shown again."
}
```

**Fields:**
- `api_key` (string): The full API key. **This is the only time the full key is returned.** Store it securely.
- `api_key_id` (string, ULID): Unique identifier for the API key. Use this for revoking the key and for tracking in job records.
- `name` (string, optional): The name assigned to the API key.
- `created_at` (string): ISO 8601 timestamp when the key was created.
- `message` (string): Reminder message about storing the key securely.

**API Key Format:**
- Production keys: `pk_live_<random_base64url_string>` (43 characters after prefix)
- Development keys: `pk_test_<random_base64url_string>` (43 characters after prefix)

**Error Responses:**
- `400 Bad Request` – Invalid JSON in request body.
- `401 Unauthorized` – Missing or invalid JWT token.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

---

### 15.2 `GET /accounts/me/api-keys`

**Description:**  
List all API keys for the authenticated user. The full API key is never returned in the list (only a prefix is shown for identification).

#### 15.2.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito) - **Required**
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.
- **Note:** API keys cannot be used to authenticate to this endpoint.

#### 15.2.2 HTTP Request

**Method:** `GET`  
**Path:** `/accounts/me/api-keys`

#### 15.2.3 Response

**Success Response (200 OK):**
```json
{
  "api_keys": [
    {
      "api_key_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "api_key_prefix": "pk_live_abc1...",
      "name": "Production API Key",
      "is_active": true,
      "created_at": "2025-12-21T10:00:00Z",
      "last_used_at": "2025-12-21T15:30:00Z",
      "revoked_at": null
    },
    {
      "api_key_id": "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "api_key_prefix": "pk_test_xyz9...",
      "name": "Development API Key",
      "is_active": false,
      "created_at": "2025-12-20T08:00:00Z",
      "last_used_at": "2025-12-20T12:00:00Z",
      "revoked_at": "2025-12-21T09:00:00Z"
    }
  ],
  "count": 2
}
```

**Fields:**
- `api_keys` (array): List of API keys, sorted by `created_at` descending (newest first).
  - `api_key_id` (string, ULID): Unique identifier for the API key. Use this for revoking and tracking.
  - `api_key_prefix` (string): First 12 characters of the API key followed by `...` (for identification only).
  - `name` (string, optional): Descriptive name for the API key.
  - `is_active` (boolean): Whether the API key is active (`false` if revoked).
  - `created_at` (string): ISO 8601 timestamp when the key was created.
  - `last_used_at` (string, optional): ISO 8601 timestamp when the key was last used (null if never used).
  - `revoked_at` (string, optional): ISO 8601 timestamp when the key was revoked (null if active).
- `count` (number): Total number of API keys (active and revoked).

**Error Responses:**
- `401 Unauthorized` – Missing or invalid JWT token.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

---

### 15.3 `DELETE /accounts/me/api-keys/{api_key_id}`

**Description:**  
Revoke an API key. The key is immediately deactivated and cannot be used for authentication. This action cannot be undone, but you can create a new API key if needed.

#### 15.3.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito) - **Required**
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.
- **Note:** API keys cannot be used to authenticate to this endpoint.

#### 15.3.2 HTTP Request

**Method:** `DELETE`  
**Path:** `/accounts/me/api-keys/{api_key_id}`

**Path Parameters:**
- `api_key_id` (string, required): The ULID of the API key to revoke (e.g., `01ARZ3NDEKTSV4RRFFQ69G5FAV`). This is returned when creating the API key and in the list response.

#### 15.3.3 Response

**Success Response (200 OK):**
```json
{
  "message": "API key revoked successfully",
  "api_key_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "api_key_prefix": "pk_live_abc1...",
  "revoked_at": "2025-12-21T10:00:00Z"
}
```

**Fields:**
- `message` (string): Confirmation message.
- `api_key_id` (string, ULID): The ID of the revoked API key.
- `api_key_prefix` (string): First 12 characters of the revoked API key followed by `...`.
- `revoked_at` (string): ISO 8601 timestamp when the key was revoked.

**Error Responses:**
- `401 Unauthorized` – Missing or invalid JWT token.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`) or API key does not belong to authenticated user.
- `404 Not Found` – API key not found.
- `500 Internal Server Error` – Server-side failure.

**Notes:**
- Revoked API keys cannot be reactivated. Create a new API key if needed.
- Revoked keys remain in the list (with `is_active: false`) for audit purposes.
- The API key must belong to the authenticated user. Attempting to revoke another user's key will result in a `403 Forbidden` error.

---

## 17. Health Check

**Description:**  
Health check endpoint to verify service availability and basic system status.

**Method:** `GET`  
**Path:** `/health`

### 16.1 Authentication

- **Type:** API Key (required)
- **Header:**
```http
X-API-Key: <api_key>
```

**Requirements:**
- API key must be valid and active (not revoked)
- API key must exist in the `ApiKeys` DynamoDB table
- API key format: `pk_live_...` (production) or `pk_test_...` (development)
- **Note:** JWT tokens are not accepted for this endpoint. Only API keys are supported.

### 16.2 HTTP Request

**Method:** `GET`  
**Path:** `/health`

**Headers:**
- `X-API-Key` (required): Valid API key

### 16.3 HTTP Response

#### 16.3.1 Success Response (200 OK)

```json
{
  "status": "ok",
  "timestamp": "2025-12-21T10:30:00.000Z",
  "uptime_ms": 123456
}
```

**Fields:**
- `status` (string): Always `"ok"` when service is healthy
- `timestamp` (string): ISO 8601 timestamp of the health check
- `uptime_ms` (number): Process uptime in milliseconds

#### 16.3.2 Error Responses

**401 Unauthorized - Missing API Key**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or invalid authentication. Provide either JWT token or API key."
  }
}
```

**401 Unauthorized - Invalid API Key**
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing or invalid authentication. Provide either JWT token or API key."
  }
}
```

**500 Internal Server Error**
```json
{
  "status": "error",
  "message": "Health check failed"
}
```

### 16.4 Example Request

```bash
curl -X GET https://api.podpdf.com/health \
  -H "X-API-Key: pk_live_abc123..."
```

### 16.5 Example Response

```json
{
  "status": "ok",
  "timestamp": "2025-12-21T10:30:00.000Z",
  "uptime_ms": 123456
}
```

### 16.6 Usage Notes

- **Purpose:** This endpoint is used for monitoring and health checks
- **Authentication:** Requires a valid API key (created via `POST /accounts/me/api-keys`)
- **Rate Limiting:** Subject to the same rate limits as other authenticated endpoints
- **Monitoring:** Can be used by monitoring systems to verify service availability

**Status Codes:**
- `200 OK` – Service healthy
- `401 Unauthorized` – Missing or invalid API key
- `500 Internal Server Error` – Health check failed

---

## 18. `POST /signup`

**Description:**  
Create a new user account in Cognito. After signup, the user will receive a verification code via email. Once they confirm their email with the code, the **Post Confirmation Lambda trigger** will automatically create the DynamoDB account record. No additional API call is needed to create the account record.

### 17.1 Authentication

- **Type:** None (public endpoint)
- **Note:** This endpoint does not require authentication. It is used to create new user accounts.

### 12.2 HTTP Request

**Method:** `POST`  
**Path:** `/signup`  
**Content-Type:** `application/json`

#### 12.2.1 Request Body

```json
{
  "email": "user@example.com",
  "password": "SecurePassword123!",
  "name": "John Doe"
}
```

**Fields:**
- `email` (string, required) - User's email address (used as username in Cognito)
- `password` (string, required) - User's password (must meet Cognito password requirements: minimum 8 characters, uppercase, lowercase, numbers, and symbols)
- `name` (string, optional) - User's display name

### 12.3 HTTP Response

#### 12.3.1 Success Response (201 Created)

```json
{
  "message": "User created successfully. Please check your email for verification code.",
  "userSub": "12345678-1234-1234-1234-123456789012",
  "email": "user@example.com",
  "requiresConfirmation": true
}
```

**Fields:**
- `message` (string) - Success message
- `userSub` (string) - Cognito user identifier (sub claim)
- `email` (string) - User's email address
- `requiresConfirmation` (boolean) - Always `true`; user must confirm email with verification code

**Next Steps:**
1. User receives verification code via email
2. User confirms email using the verification code (via `/signin` endpoint with confirmation, or via Cognito Hosted UI)
3. **Post Confirmation trigger automatically creates DynamoDB account record** - no additional API call needed
4. User can then sign in using `/signin` endpoint

#### 12.3.2 Error Responses

**400 Bad Request - Missing Fields**
```json
{
  "error": "BadRequest",
  "message": "Missing required fields: email and password"
}
```

**400 Bad Request - Invalid Email Format**
```json
{
  "error": "BadRequest",
  "message": "Invalid email format"
}
```

**400 Bad Request - Password Too Short**
```json
{
  "error": "BadRequest",
  "message": "Password must be at least 8 characters long"
}
```

**400 Bad Request - Username Already Exists**
```json
{
  "error": "BadRequest",
  "message": "An account with this email already exists"
}
```

**400 Bad Request - Invalid Password**
```json
{
  "error": "BadRequest",
  "message": "Password does not meet requirements. Password must be at least 8 characters and contain uppercase, lowercase, numbers, and symbols."
}
```

**429 Too Many Requests**
```json
{
  "error": "TooManyRequests",
  "message": "Too many sign-up attempts. Please try again later."
}
```

**500 Internal Server Error**
```json
{
  "error": "InternalServerError",
  "message": "Sign-up failed. Please try again later."
}
```

### 12.4 Example Request

```bash
curl -X POST https://api.podpdf.com/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123!",
    "name": "John Doe"
  }'
```

### 12.5 Example Response

```json
{
  "message": "User created successfully. Please check your email for verification code.",
  "userSub": "12345678-1234-1234-1234-123456789012",
  "email": "user@example.com",
  "requiresConfirmation": true
}
```

### 12.6 Usage Notes

- **Password Requirements:** Password must be at least 8 characters and contain:
  - At least one uppercase letter
  - At least one lowercase letter
  - At least one number
  - At least one symbol
- **Email Verification:** After signup, user receives a verification code via email. They must confirm their email before they can sign in.
- **Automatic Account Creation:** Once the user confirms their email with the verification code, the **Post Confirmation Lambda trigger** automatically creates the DynamoDB account record. No additional API call to `/accounts` is needed.
- **Account Record:** The account record is created with:
  - `plan_id`: `"free-basic"` (default free plan)
  - `account_status`: `"free"`
  - `total_pdf_count`: `0`
  - `quota_exceeded`: `false`
- **Sign In:** After email confirmation, user can sign in using the `/signin` endpoint.

**Status Codes:**
- `201 Created` – User created successfully (requires email confirmation)
- `400 Bad Request` – Missing fields, invalid email, weak password, or username already exists
- `429 Too Many Requests` – Too many sign-up attempts
- `500 Internal Server Error` – Sign-up service error

---

## 19. `POST /confirm-signup`

**Description:**  
Confirm user email with the verification code received via email. After successful confirmation, the **Post Confirmation Lambda trigger** will automatically create the DynamoDB account record. Once confirmed, the user can sign in using the `/signin` endpoint.

### 18.1 Authentication

- **Type:** None (public endpoint)
- **Note:** This endpoint does not require authentication. It is used to confirm email addresses after signup.

### 18.2 HTTP Request

**Method:** `POST`  
**Path:** `/confirm-signup`  
**Content-Type:** `application/json`

#### 18.2.1 Request Body

```json
{
  "email": "user@example.com",
  "confirmationCode": "123456"
}
```

**Fields:**
- `email` (string, required) - User's email address (same email used in signup)
- `confirmationCode` (string, required) - 6-digit verification code received via email

### 18.3 HTTP Response

#### 18.3.1 Success Response (200 OK)

```json
{
  "message": "Email confirmed successfully. Your account has been created. You can now sign in.",
  "email": "user@example.com"
}
```

**Fields:**
- `message` (string) - Success message
- `email` (string) - Confirmed email address

**What Happens Next:**
1. **Post Confirmation trigger automatically creates DynamoDB account record** - no additional API call needed
2. Account record is created with:
   - `plan_id`: `"free-basic"` (default free plan)
   - `account_status`: `"free"`
   - `total_pdf_count`: `0`
   - `quota_exceeded`: `false`
3. User can now sign in using the `/signin` endpoint

#### 13.3.2 Error Responses

**400 Bad Request - Missing Fields**
```json
{
  "error": "BadRequest",
  "message": "Missing required fields: email and confirmationCode"
}
```

**400 Bad Request - Invalid Email Format**
```json
{
  "error": "BadRequest",
  "message": "Invalid email format"
}
```

**400 Bad Request - Invalid Code**
```json
{
  "error": "BadRequest",
  "message": "Invalid verification code. Please check your email and try again."
}
```

**400 Bad Request - Expired Code**
```json
{
  "error": "BadRequest",
  "message": "Verification code has expired. Please request a new code."
}
```

**400 Bad Request - Already Confirmed**
```json
{
  "error": "BadRequest",
  "message": "User is already confirmed or does not exist."
}
```

**400 Bad Request - User Not Found**
```json
{
  "error": "BadRequest",
  "message": "User not found. Please sign up first."
}
```

**429 Too Many Requests**
```json
{
  "error": "TooManyRequests",
  "message": "Too many confirmation attempts. Please try again later."
}
```

**500 Internal Server Error**
```json
{
  "error": "InternalServerError",
  "message": "Confirmation failed. Please try again later."
}
```

### 15.4 Example Request

```bash
curl -X POST https://api.podpdf.com/confirm-signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "confirmationCode": "123456"
  }'
```

### 15.5 Example Response

```json
{
  "message": "Email confirmed successfully. Your account has been created. You can now sign in.",
  "email": "user@example.com"
}
```

### 15.6 Usage Notes

- **Verification Code:** The code is a 6-digit number sent via email after signup. It expires after a certain period (typically 24 hours).
- **Automatic Account Creation:** Once the email is confirmed, the **Post Confirmation Lambda trigger** automatically creates the DynamoDB account record. No additional API call to `/accounts` is needed.
- **One-Time Use:** Each verification code can only be used once. If you need a new code, you may need to resend it (if a resend endpoint is available).
- **Sign In:** After successful confirmation, the user can immediately sign in using the `/signin` endpoint with their email and password.
- **Already Confirmed:** If the user is already confirmed, the endpoint will return an error. They can proceed directly to sign in.

**Status Codes:**
- `200 OK` – Email confirmed successfully, account record created automatically
- `400 Bad Request` – Missing fields, invalid email, invalid/expired code, or user already confirmed
- `429 Too Many Requests` – Too many confirmation attempts
- `500 Internal Server Error` – Confirmation service error

---

## 20. `POST /signin`

**Description:**  
Authenticate a user with Cognito and return JWT tokens (ID token, access token, refresh token).

### 19.1 Authentication

- **Type:** None (public endpoint)
- **Note:** This endpoint does not require authentication. It is used to obtain authentication tokens.

### 19.2 HTTP Request

**Method:** `POST`  
**Path:** `/signin`  
**Content-Type:** `application/json`

#### 19.2.1 Request Body

```json
{
  "email": "user@example.com",
  "password": "SecurePassword123!"
}
```

**Fields:**
- `email` (string, required) - User's email address (used as username in Cognito)
- `password` (string, required) - User's password

### 19.3 HTTP Response

#### 19.3.1 Success Response (200 OK)

```json
{
  "message": "Sign-in successful",
  "tokens": {
    "idToken": "eyJraWQiOiJcL0t...",
    "accessToken": "eyJraWQiOiJcL0t...",
    "refreshToken": "eyJjdHkiOiJKV1QiLCJlbmMiOiJBMjU2R0NNIn0...",
    "expiresIn": 86400
  }
}
```

**Fields:**
- `message` (string) - Success message
- `tokens` (object) - Authentication tokens
  - `idToken` (string) - JWT ID token (contains user claims)
  - `accessToken` (string) - JWT access token (for API authorization)
  - `refreshToken` (string) - Refresh token (for obtaining new tokens)
  - `expiresIn` (number) - Token expiration time in seconds

#### 19.3.2 Error Responses

**400 Bad Request - Missing Fields**
```json
{
  "error": "BadRequest",
  "message": "Missing required fields: email and password"
}
```

**400 Bad Request - User Not Confirmed**
```json
{
  "error": "BadRequest",
  "message": "User account is not confirmed. Please verify your email address."
}
```

**401 Unauthorized - Invalid Credentials**
```json
{
  "error": "Unauthorized",
  "message": "Invalid email or password"
}
```

**429 Too Many Requests**
```json
{
  "error": "TooManyRequests",
  "message": "Too many sign-in attempts. Please try again later."
}
```

**500 Internal Server Error**
```json
{
  "error": "InternalServerError",
  "message": "Authentication failed. Please try again later."
}
```

### 15.4 Example Request

```bash
curl -X POST https://api.podpdf.com/signin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123!"
  }'
```

### 15.5 Example Response

```json
{
  "message": "Sign-in successful",
  "tokens": {
    "idToken": "eyJraWQiOiJcL0t...",
    "accessToken": "eyJraWQiOiJcL0t...",
    "refreshToken": "eyJjdHkiOiJKV1QiLCJlbmMiOiJBMjU2R0NNIn0...",
    "expiresIn": 86400
  }
}
```

### 19.6 Usage Notes

- **Token Usage:** Use the `accessToken` in the `Authorization` header for authenticated API requests: `Authorization: Bearer <accessToken>`
- **Token Expiration:** Tokens expire after 24 hours (as configured in Cognito). Use the `/refresh` endpoint with the `refreshToken` to obtain new tokens.
- **Rate Limiting:** Cognito enforces rate limits on authentication attempts. Too many failed attempts will result in a 429 error.

**Status Codes:**
- `200 OK` – Sign-in successful
- `400 Bad Request` – Missing fields or user not confirmed
- `401 Unauthorized` – Invalid credentials
- `429 Too Many Requests` – Too many sign-in attempts
- `500 Internal Server Error` – Authentication service error

---

## 20. `POST /refresh`

**Description:**  
Refresh authentication tokens using a refresh token. Returns new ID token and access token.

### 15.1 Authentication

- **Type:** None (public endpoint)
- **Note:** This endpoint does not require authentication. It is used to refresh expired tokens.

### 15.2 HTTP Request

**Method:** `POST`  
**Path:** `/refresh`  
**Content-Type:** `application/json`

#### 15.2.1 Request Body

```json
{
  "refreshToken": "eyJjdHkiOiJKV1QiLCJlbmMiOiJBMjU2R0NNIn0..."
}
```

**Fields:**
- `refreshToken` (string, required) - Refresh token obtained from `/signin` endpoint

### 20.3 HTTP Response

#### 20.3.1 Success Response (200 OK)

```json
{
  "message": "Token refresh successful",
  "tokens": {
    "idToken": "eyJraWQiOiJcL0t...",
    "accessToken": "eyJraWQiOiJcL0t...",
    "expiresIn": 86400
  }
}
```

**Fields:**
- `message` (string) - Success message
- `tokens` (object) - New authentication tokens
  - `idToken` (string) - JWT ID token (contains user claims)
  - `accessToken` (string) - JWT access token (for API authorization)
  - `expiresIn` (number) - Token expiration time in seconds

**Note:** The refresh token is not returned in the response. The same refresh token can be reused until it expires (30 days as configured in Cognito).

#### 15.3.2 Error Responses

**400 Bad Request - Missing Field**
```json
{
  "error": "BadRequest",
  "message": "Missing required field: refreshToken"
}
```

**400 Bad Request - Invalid Type**
```json
{
  "error": "BadRequest",
  "message": "refreshToken must be a string"
}
```

**401 Unauthorized - Invalid Refresh Token**
```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired refresh token"
}
```

**429 Too Many Requests**
```json
{
  "error": "TooManyRequests",
  "message": "Too many refresh attempts. Please try again later."
}
```

**500 Internal Server Error**
```json
{
  "error": "InternalServerError",
  "message": "Token refresh failed. Please try again later."
}
```

### 15.4 Example Request

```bash
curl -X POST https://api.podpdf.com/refresh \
  -H "Content-Type: application/json" \
  -d '{
    "refreshToken": "eyJjdHkiOiJKV1QiLCJlbmMiOiJBMjU2R0NNIn0..."
  }'
```

### 15.5 Example Response

```json
{
  "message": "Token refresh successful",
  "tokens": {
    "idToken": "eyJraWQiOiJcL0t...",
    "accessToken": "eyJraWQiOiJcL0t...",
    "expiresIn": 86400
  }
}
```

### 15.6 Usage Notes

- **Token Refresh:** Use this endpoint when your access token or ID token expires (after 24 hours). The refresh token is valid for 30 days.
- **Token Usage:** Use the new `accessToken` in the `Authorization` header for authenticated API requests: `Authorization: Bearer <accessToken>`
- **Refresh Token Reuse:** The same refresh token can be used multiple times until it expires. You do not receive a new refresh token on each refresh.
- **Rate Limiting:** Cognito enforces rate limits on refresh attempts. Too many attempts will result in a 429 error.

**Status Codes:**
- `200 OK` – Token refresh successful
- `400 Bad Request` – Missing or invalid refresh token field
- `401 Unauthorized` – Invalid or expired refresh token
- `429 Too Many Requests` – Too many refresh attempts
- `500 Internal Server Error` – Token refresh service error

---

## Webhook Payload Format

When a long job completes, a POST request is sent to the configured webhook URL with the following payload:

```json
{
  "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
  "status": "completed",
  "s3_url": "https://s3.amazonaws.com/podpdf-dev-pdfs/9f0a4b78-2c0c-4d14-9b8b-123456789abc.pdf?X-Amz-Signature=...",
  "s3_url_expires_at": "2025-12-21T11:32:15Z",
  "pages": 150,
  "mode": "html",
  "truncated": false,
  "created_at": "2025-12-21T10:30:00Z",
  "completed_at": "2025-12-21T10:32:15Z"
}
```

**Webhook Retry Logic:**
- Up to 3 retries with exponential backoff (1s, 2s, 4s)
- Retry attempts are logged in `JobDetails` and `Analytics` tables
- If all retries fail, job is still marked as completed, but webhook delivery failure is logged

**Webhook Response:**
- Webhook endpoint should return `200 OK` to confirm receipt
- Any other status code will trigger retries

---

## 22. Webhook Management (Multiple Webhooks)

**Description:**  
Manage multiple webhook configurations per user with event-based subscriptions. This replaces the single webhook URL approach with a more flexible system that supports multiple webhooks, event filtering, and delivery tracking.

**Note:** The legacy `PUT /accounts/me/webhook` endpoint (section 13) is **deprecated** and will be removed on January 1, 2026. Please migrate to the new webhook management system which provides enhanced features:
- Multiple webhooks per user (plan-based limits)
- Event-based subscriptions (subscribe only to events you care about)
- Delivery history and statistics tracking
- Webhook activation/deactivation

### 22.1 Authentication

All webhook management endpoints require:
- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired
- User account must exist in `Users` table

### 22.2 Plan-Based Limits

Maximum webhooks per user is determined by their plan:
- **Free tier plans:** 1 webhook
- **Paid tier plans:** 5 webhooks (default)
- **Enterprise tier plans:** 50 webhooks

The limit is configured in the `Plans` table (`max_webhooks` field). If the limit is reached, creating a new webhook returns `403 Forbidden` with error code `WEBHOOK_LIMIT_EXCEEDED`.

---

## 22.1 `POST /accounts/me/webhooks`

**Description:**  
Create a new webhook configuration.

### 22.1.1 HTTP Request

**Method:** `POST`  
**Path:** `/accounts/me/webhooks`  
**Content-Type:** `application/json`

#### 22.1.2 Request Body

```json
{
  "name": "Production Webhook",
  "url": "https://api.example.com/webhooks/podpdf",
  "events": ["job.completed", "job.failed"],
  "is_active": true
}
```

**Fields:**
- `name` (string, optional) - Descriptive name for the webhook (e.g., "Production Webhook", "Staging Webhook")
- `url` (string, required) - HTTPS URL for webhook endpoint
  - Must be a valid HTTPS URL
  - URL length: 1-2048 characters
- `events` (array of strings, optional) - Event types to subscribe to
  - Default: `["job.completed"]` if not specified
  - Valid values: `job.completed`, `job.failed`, `job.timeout`, `job.queued`, `job.processing`
  - Array cannot be empty
- `is_active` (boolean, optional) - Whether webhook is active (default: `true`)
  - Inactive webhooks are not called

### 22.1.3 Response

#### 22.1.3.1 Success Response

- **Status:** `201 Created`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "webhook_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "name": "Production Webhook",
  "url": "https://api.example.com/webhooks/podpdf",
  "events": ["job.completed", "job.failed"],
  "is_active": true,
  "created_at": "2025-12-24T10:00:00Z",
  "updated_at": "2025-12-24T10:00:00Z",
  "success_count": 0,
  "failure_count": 0
}
```

**Fields:**
- `webhook_id` (string) - Unique webhook identifier (ULID)
- `name` (string, optional) - Webhook name
- `url` (string) - Webhook URL
- `events` (array) - Subscribed event types
- `is_active` (boolean) - Active status
- `created_at` (string) - ISO 8601 timestamp
- `updated_at` (string) - ISO 8601 timestamp
- `success_count` (number) - Total successful deliveries (starts at 0)
- `failure_count` (number) - Total failed deliveries (starts at 0)

#### 22.1.3.2 Error Responses

- `400 Bad Request` - Invalid URL, invalid events, or malformed request
  - Error code: `INVALID_WEBHOOK_URL` - URL must be HTTPS
  - Error code: `INVALID_EVENTS` - Invalid event type or empty events array
- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Account not found or webhook limit exceeded
  - Error code: `ACCOUNT_NOT_FOUND` - User account not found
  - Error code: `WEBHOOK_LIMIT_EXCEEDED` - Maximum webhooks reached for plan
    - Includes details: `plan_id`, `plan_type`, `current_count`, `max_allowed`, `upgrade_required`
- `500 Internal Server Error` - Server-side failure

---

## 22.2 `GET /accounts/me/webhooks`

**Description:**  
List all webhooks for the authenticated user.

### 22.2.1 HTTP Request

**Method:** `GET`  
**Path:** `/accounts/me/webhooks`

#### 22.2.2 Query Parameters

- `is_active` (boolean, optional) - Filter by active status (`true` or `false`)
- `event` (string, optional) - Filter webhooks that subscribe to this event type
  - Valid values: `job.completed`, `job.failed`, `job.timeout`, `job.queued`, `job.processing`
- `limit` (number, optional) - Maximum results (default: 50, max: 100)
- `next_token` (string, optional) - Pagination token from previous response

### 22.2.2 Response

#### 22.2.2.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

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

**Fields:**
- `webhooks` (array) - List of webhook configurations
- `count` (number) - Number of webhooks in this response
- `next_token` (string, optional) - Pagination token for next page (null if last page)

#### 22.2.2.2 Error Responses

- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Account not found
- `500 Internal Server Error` - Server-side failure

---

## 22.3 `GET /accounts/me/webhooks/{webhook_id}`

**Description:**  
Get details of a specific webhook.

### 22.3.1 HTTP Request

**Method:** `GET`  
**Path:** `/accounts/me/webhooks/{webhook_id}`

**Path Parameters:**
- `webhook_id` (string, required) - Webhook identifier (ULID)

### 22.3.2 Response

#### 22.3.2.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

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

#### 22.3.2.2 Error Responses

- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Account not found or webhook doesn't belong to user
  - Error code: `ACCOUNT_NOT_FOUND` - User account not found
  - Error code: `WEBHOOK_ACCESS_DENIED` - Webhook belongs to different user
- `404 Not Found` - Webhook not found
  - Error code: `WEBHOOK_NOT_FOUND`
- `500 Internal Server Error` - Server-side failure

---

## 22.4 `PUT /accounts/me/webhooks/{webhook_id}`

**Description:**  
Update an existing webhook configuration.

### 22.4.1 HTTP Request

**Method:** `PUT`  
**Path:** `/accounts/me/webhooks/{webhook_id}`  
**Content-Type:** `application/json`

**Path Parameters:**
- `webhook_id` (string, required) - Webhook identifier (ULID)

#### 22.4.2 Request Body

```json
{
  "name": "Updated Production Webhook",
  "url": "https://api.example.com/webhooks/podpdf-v2",
  "events": ["job.completed"],
  "is_active": true
}
```

**Fields:** Same as POST, all optional (only provided fields are updated)
- `name` (string, optional) - Update webhook name
- `url` (string, optional) - Update webhook URL (must be HTTPS)
- `events` (array of strings, optional) - Update subscribed events
- `is_active` (boolean, optional) - Update active status

### 22.4.3 Response

#### 22.4.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "webhook_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "name": "Updated Production Webhook",
  "url": "https://api.example.com/webhooks/podpdf-v2",
  "events": ["job.completed"],
  "is_active": true,
  "created_at": "2025-12-24T10:00:00Z",
  "updated_at": "2025-12-24T16:00:00Z",
  "success_count": 150,
  "failure_count": 2
}
```

#### 22.4.3.2 Error Responses

Same as GET endpoint (22.3.2.2)

---

## 22.5 `DELETE /accounts/me/webhooks/{webhook_id}`

**Description:**  
Delete a webhook configuration.

### 22.5.1 HTTP Request

**Method:** `DELETE`  
**Path:** `/accounts/me/webhooks/{webhook_id}`

**Path Parameters:**
- `webhook_id` (string, required) - Webhook identifier (ULID)

### 22.5.2 Response

#### 22.5.2.1 Success Response

- **Status:** `204 No Content`
- **Body:** Empty

#### 22.5.2.2 Error Responses

- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Account not found or webhook doesn't belong to user
- `404 Not Found` - Webhook not found
- `500 Internal Server Error` - Server-side failure

---

## 22.6 `GET /accounts/me/webhooks/{webhook_id}/history`

**Description:**  
Get delivery history for a webhook.

### 22.6.1 HTTP Request

**Method:** `GET`  
**Path:** `/accounts/me/webhooks/{webhook_id}/history`

**Path Parameters:**
- `webhook_id` (string, required) - Webhook identifier (ULID)

#### 22.6.2 Query Parameters

- `status` (string, optional) - Filter by delivery status
  - Valid values: `success`, `failed`, `timeout`
- `event_type` (string, optional) - Filter by event type
  - Valid values: `job.completed`, `job.failed`, `job.timeout`, `job.queued`, `job.processing`
- `limit` (number, optional) - Maximum results (default: 50, max: 100)
- `next_token` (string, optional) - Pagination token from previous response

### 22.6.3 Response

#### 22.6.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

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
      "duration_ms": 245,
      "payload_size_bytes": 1024
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
      "duration_ms": 7500,
      "payload_size_bytes": 1024
    }
  ],
  "count": 2,
  "next_token": null
}
```

**Fields:**
- `history` (array) - List of delivery records
  - `delivery_id` (string) - Unique delivery identifier (ULID)
  - `job_id` (string) - Job ID that triggered this webhook
  - `event_type` (string) - Event type that triggered webhook
  - `status` (string) - Delivery status: `success`, `failed`, or `timeout`
  - `status_code` (number, optional) - HTTP status code from webhook endpoint
  - `error_message` (string, optional) - Error message if delivery failed
  - `retry_count` (number) - Number of retry attempts (0-3)
  - `delivered_at` (string) - ISO 8601 timestamp when delivery completed
  - `duration_ms` (number) - Total delivery duration in milliseconds
  - `payload_size_bytes` (number) - Size of webhook payload in bytes
- `count` (number) - Number of history records in this response
- `next_token` (string, optional) - Pagination token for next page

**Note:** History records are kept permanently (no TTL). This provides long-term retention for debugging, auditing, and troubleshooting.

#### 22.6.3.2 Error Responses

- `401 Unauthorized` - Missing or invalid JWT token
- `403 Forbidden` - Account not found or webhook doesn't belong to user
- `404 Not Found` - Webhook not found
- `500 Internal Server Error` - Server-side failure

---

## 22.7 Webhook Event Types

The following event types can be subscribed to:

### 22.7.1 `job.completed`

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

### 22.7.2 `job.failed`

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

### 22.7.3 `job.timeout`

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

### 22.7.4 `job.queued`

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

### 22.7.5 `job.processing`

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

### 22.7.6 Webhook Headers

All webhook requests include standard headers:
- `Content-Type: application/json`
- `User-Agent: PodPDF-Webhook/1.0`
- `X-Webhook-Event: <event_type>` (e.g., `X-Webhook-Event: job.completed`)
- `X-Webhook-Id: <webhook_id>` - Webhook identifier
- `X-Webhook-Delivery-Id: <delivery_id>` - Unique delivery identifier
- `X-Webhook-Timestamp: <iso_timestamp>` - Event timestamp

### 22.7.7 Webhook Delivery

**Retry Logic:
- System defaults: 3 retries with exponential backoff (1s, 2s, 4s)
- Retries on:
  - Network errors
  - Timeout (10 seconds)
  - HTTP 5xx errors
  - HTTP 429 (Too Many Requests)
- Does NOT retry on:
  - HTTP 2xx (success)
  - HTTP 4xx (client errors, except 429)

**Delivery Guarantees:**
- **At-least-once delivery:** Webhooks may be delivered multiple times in case of retries or system failures
- **Best-effort delivery:** Failed webhooks are retried, but if all retries fail, delivery is not guaranteed
- **Ordering:** Webhooks are delivered in the order events occur, but delivery order is not guaranteed across different webhooks
- **Idempotency:** Webhook receivers should handle duplicate deliveries (use `delivery_id` to deduplicate)

**Webhook Receiver Validation:**
Webhook receivers should:
1. Validate payload structure (check required fields and types)
2. Use `delivery_id` from `X-Webhook-Delivery-Id` header for idempotency
3. Return `200 OK` quickly, process asynchronously if needed
