## PodPDF API Endpoints

This document describes the public HTTP endpoints exposed by the PodPDF API.

All endpoints are served via **Amazon API Gateway HTTP API (v2)** and backed by Lambda functions.

**Note:** User account creation is handled automatically via a **Cognito Post Confirmation Lambda trigger**. When a user signs up via Amplify and confirms their email, the account record is automatically created in DynamoDB. The `POST /accounts` endpoint is available as a fallback for manual account creation if needed.

---

## 1. `POST /quickjob`

**Description:**  
Synchronous PDF generation for small documents that complete in under 30 seconds. Returns PDF binary directly in HTTP response.

### 1.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users` (no anonymous or first-call auto-account creation).

### 1.2 HTTP Request

**Method:** `POST`  
**Path:** `/quickjob`  
**Content-Type:** `application/json`

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

#### 1.2.3 Request Fields

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

### 1.3 Validation Rules (Summary)

1. **Authentication**
   - JWT must be present and valid, or request is rejected with **401** (`UNAUTHORIZED`).

2. **Account**
   - `Users` record must exist for the `sub`; otherwise **403** (`ACCOUNT_NOT_FOUND`).

3. **Body**
   - `input_type` must be `"html"` or `"markdown"`.
   - Exactly one of `html` or `markdown` must be provided (non-empty).
   - Content must match `input_type` (basic starting-tag check).
   - Input size must be ≤ ~5 MB.

4. **Business Logic**
   - Free tier:
     - Per-user rate limit: 20 req/min (**403** `RATE_LIMIT_EXCEEDED` on breach).
     - All-time quota: Configurable per plan via `monthly_quota` in `Plans` table (default: 100 PDFs from `FREE_TIER_QUOTA` environment variable) (**403** `QUOTA_EXCEEDED` after that; must upgrade).
   - Paid plan:
     - No quota; still subject to API Gateway throttling.
   - **Page Limit:** Maximum page limit is enforced per environment (e.g., 2 pages in dev, 100 pages in prod). If the generated PDF exceeds this limit, the request is rejected with **400** `PAGE_LIMIT_EXCEEDED` error. No truncation is performed.

### 1.4 Response

#### 1.4.1 Success Response

- **Status:** `200 OK`
- **Headers:**

```http
Content-Type: application/pdf
Content-Disposition: inline; filename="document.pdf"
X-PDF-Pages: 42
X-Job-Id: 9f0a4b78-2c0c-4d14-9b8b-123456789abc
```

- **Body:** Binary PDF content (up to maximum allowed pages per environment).

**Notes:**
- Maximum page limit is enforced per environment (e.g., 2 pages in dev, 100 pages in prod).
- If the rendered PDF exceeds the maximum page limit, the request is rejected with a `400 Bad Request` error (`PAGE_LIMIT_EXCEEDED`).
- No truncation is performed - the entire request is rejected if the limit is exceeded.

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

- `401 Unauthorized`
  - Missing or invalid JWT

- `403 Forbidden`
  - Account not found (`ACCOUNT_NOT_FOUND`)
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

### 2.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.

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
  },
  "webhook_url": "https://example.com/webhook"
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
  },
  "webhook_url": "https://example.com/webhook"
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
- `webhook_url` (string, optional)
  - Override user's default webhook URL for this job.
  - Must be a valid HTTPS URL.
  - If not provided, uses user's default webhook URL from `Users` table.

### 2.3 Validation Rules (Summary)

Same validation as `/quickjob` (authentication, account, body, business logic), plus:

- **Page Limit Check:** The PDF is generated synchronously before queuing to validate the page count. If the page limit is exceeded, the request is rejected immediately with `400 Bad Request` (`PAGE_LIMIT_EXCEEDED`). The job is only queued if the page limit check passes.
- `webhook_url` (if provided) must be a valid HTTPS URL.

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
- `400 Bad Request` – Invalid `webhook_url` (not HTTPS or malformed URL).
- `400 Bad Request` – PDF page count exceeds maximum allowed pages (`PAGE_LIMIT_EXCEEDED`). **This error is returned immediately before queuing the job.** No job record is created and no webhook will be sent.

**Note:** The page limit is checked synchronously before queuing. If the limit is exceeded, the error is returned immediately in the initial response. If the check passes, the job is queued and processing happens asynchronously. Use `GET /jobs/{job_id}` to check status, or wait for webhook notification.

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
- `mode` (string): `"html"` or `"markdown"`.
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
- `error_message` (string, optional): Error message if status is `"failed"` or `"timeout"`.

#### 3.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `404 Not Found` – Job not found or doesn't belong to authenticated user.
- `500 Internal Server Error` – Server-side failure.

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

- **`400 Bad Request`** – Missing required fields.
  ```json
  {
    "error": {
      "code": "MISSING_USER_SUB",
      "message": "user_sub field is required"
    }
  }
  ```
  
  Or:
  ```json
  {
    "error": {
      "code": "MISSING_EMAIL",
      "message": "email field is required"
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
      "message": "Internal server error"
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

## 6. `GET /accounts/me`

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

### 6.2 HTTP Request

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
    "monthly_quota": 100,
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

## 7. `GET /accounts/me/billing`

**Description:**  
Get current month's billing summary for the authenticated user. Returns accumulated billing amount and PDF count for the current month only.

**Note:** For a complete list of all bills/invoices, use `GET /accounts/me/bills`.

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
    "billing_month": "2025-12",
    "monthly_billing_amount": 0.125,
    "pdf_count": 25,
    "price_per_pdf": 0.005,
    "is_paid": false
  }
}
```

**For Free Plan Users:**
```json
{
  "billing": {
    "plan_id": "free-basic",
    "plan_type": "free",
    "billing_month": "2025-12",
    "monthly_billing_amount": 0,
    "pdf_count": 42,
    "price_per_pdf": 0,
    "is_paid": false
  }
}
```

**Fields:**
- `plan_id` (string): Current plan ID.
- `plan_type` (string): `"free"` or `"paid"`.
- `billing_month` (string): Current billing month in `YYYY-MM` format (e.g., `"2025-12"`).
- `monthly_billing_amount` (number): Total amount accumulated for the current month in USD. `0` for free plan users or if no bill exists for current month.
- `pdf_count` (number): 
  - **For free plan users:** All-time PDF count (cumulative total since account creation, does not reset).
  - **For paid plan users:** Current month's PDF count only.
- `price_per_pdf` (number): Price per PDF from the plan configuration. `0` for free plan users.
- `is_paid` (boolean): Whether the current month's bill has been paid. `false` for free plan users.

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
    "billing_month": "2025-12",
    "monthly_billing_amount": 0.125,
    "pdf_count": 25,
    "price_per_pdf": 0.005,
    "is_paid": false
  }
}
```

**Free Plan User:**
```json
{
  "billing": {
    "plan_id": "free-basic",
    "plan_type": "free",
    "billing_month": "2025-12",
    "monthly_billing_amount": 0,
    "pdf_count": 42,
    "price_per_pdf": 0,
    "is_paid": false
  }
}
```

### 7.6 Usage Notes

- **PDF Count Behavior:**
  - **Free Plan Users:** `pdf_count` shows the **all-time total** (cumulative since account creation, does not reset).
  - **Paid Plan Users:** `pdf_count` shows the **current month's count only** (resets each month).
- **Current Month Summary:** For paid plan users, `monthly_billing_amount` and `pdf_count` show the current month's usage. For free plan users, `monthly_billing_amount` is always `0`, but `pdf_count` shows all-time total.
- **Bills Table:** Monthly billing information is stored in a separate `Bills` table. Each month gets a new bill record.
- **Billing Calculation:** For paid plan users, `monthly_billing_amount = pdf_count × price_per_pdf`.
- **Bill Creation:** Bill records are automatically created when a paid user generates their first PDF of the month.
- **Payment Status:** The `is_paid` flag indicates whether the bill has been paid. This can be updated when payment is processed (e.g., via Paddle integration).
- **Billing Month Format:** The `billing_month` field uses `YYYY-MM` format (e.g., `"2025-12"` for December 2025).

---

## 8. `GET /accounts/me/bills`

**Description:**  
Get a list of all bills/invoices for the authenticated user. Returns all monthly billing records sorted by month (most recent first).

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
- **Historical Records:** All bills are preserved for invoicing and accounting purposes.

---

## 9. `PUT /accounts/me/upgrade`

**Description:**  
Upgrade a user account from free tier to a paid plan. This endpoint clears the `quota_exceeded` flag and updates the user's plan.

### 9.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users` table.

### 9.2 HTTP Request

**Method:** `PUT`  
**Path:** `/accounts/me/upgrade`  
**Content-Type:** `application/json`

#### 9.2.1 Request Body

```json
{
  "plan_id": "paid-standard"
}
```

**Fields:**
- `plan_id` (string, required): The ID of the paid plan to upgrade to (e.g., `"paid-standard"`).

### 9.3 Response

#### 9.3.1 Success Response

**Status Code:** `200 OK`

```json
{
  "message": "Account upgraded successfully",
  "plan": {
    "plan_id": "paid-standard",
    "name": "Paid Standard",
    "type": "paid",
    "price_per_pdf": 0.005
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

#### 9.3.2 Error Responses

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
    "details": {}
  }
}
```

### 9.4 Example Request

```bash
curl -X PUT https://api.podpdf.com/accounts/me/upgrade \
  -H "Authorization: Bearer <jwt_token>" \
  -H "Content-Type: application/json" \
  -d '{
    "plan_id": "paid-standard"
  }'
```

### 9.5 Example Response

```json
{
  "message": "Account upgraded successfully",
  "plan": {
    "plan_id": "paid-standard",
    "name": "Paid Standard",
    "type": "paid",
    "price_per_pdf": 0.005
  },
  "upgraded_at": "2025-12-24T15:30:00Z"
}
```

### 9.6 Usage Notes

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

## 10. `PUT /accounts/me/webhook`

**Description:**  
Configure user's default webhook URL for long job notifications.

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

**Note:** This sets the default webhook URL for all long jobs. You can override it per-job by providing `webhook_url` in the `POST /longjob` request body.

---

## 11. `DELETE /accounts/me`

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

## 11. Health Check (Optional, Internal)

> **Note:** This endpoint is optional and not required for the public API. It is recommended for internal monitoring.

**Method:** `GET`  
**Path:** `/health` (could be internal-only or protected)

### 9.1 Purpose

- Verify that the Lambda function is reachable and basic dependencies are responsive (e.g., quick check to DynamoDB).

### 9.2 Response (Example)

```json
{
  "status": "ok",
  "uptime_ms": 123456,
  "dependencies": {
    "dynamodb": "ok"
  }
}
```

**Status Codes:**
- `200 OK` – Service healthy
- `500 Internal Server Error` – Health check failed

Implementation of `/health` is left to the service owner and may be internal-only (not exposed via public API Gateway).

---

## 12. `POST /signin` (Testing Only)

**Description:**  
⚠️ **Note:** This endpoint is for **testing purposes only**. Production frontend should use AWS Amplify Auth for authentication.

Authenticate a user with Cognito and return JWT tokens (ID token, access token, refresh token).

### 6.1 Authentication

- **Type:** None (public endpoint)
- **Note:** This endpoint does not require authentication. It is used to obtain authentication tokens.

### 6.2 HTTP Request

**Method:** `POST`  
**Path:** `/signin`  
**Content-Type:** `application/json`

#### 6.2.1 Request Body

```json
{
  "email": "user@example.com",
  "password": "SecurePassword123!"
}
```

**Fields:**
- `email` (string, required) - User's email address (used as username in Cognito)
- `password` (string, required) - User's password

### 6.3 HTTP Response

#### 6.3.1 Success Response (200 OK)

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

#### 6.3.2 Error Responses

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

### 6.4 Example Request

```bash
curl -X POST https://api.podpdf.com/signin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123!"
  }'
```

### 6.5 Example Response

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

### 6.6 Usage Notes

- **Testing Only:** This endpoint is provided for testing purposes. Production applications should use AWS Amplify Auth SDK.
- **Token Usage:** Use the `accessToken` in the `Authorization` header for authenticated API requests: `Authorization: Bearer <accessToken>`
- **Token Expiration:** Tokens expire after 24 hours (as configured in Cognito). Use the `refreshToken` to obtain new tokens.
- **Rate Limiting:** Cognito enforces rate limits on authentication attempts. Too many failed attempts will result in a 429 error.

**Status Codes:**
- `200 OK` – Sign-in successful
- `400 Bad Request` – Missing fields or user not confirmed
- `401 Unauthorized` – Invalid credentials
- `429 Too Many Requests` – Too many sign-in attempts
- `500 Internal Server Error` – Authentication service error

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
