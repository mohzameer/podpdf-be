## PodPDF API Endpoints

This document describes the public HTTP endpoints exposed by the PodPDF API in the MVP.

All endpoints are served via **Amazon API Gateway HTTP API (v2)** and backed by a single Lambda function.

---

## 1. `POST /generate`

**Description:**  
Generate a PDF from HTML or Markdown content and return it synchronously in the response.

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
**Path:** `/generate`  
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
     - All-time quota: 100 PDFs (**403** `QUOTA_EXCEEDED` after that; must upgrade).
   - Paid plan:
     - No quota; still subject to WAF/API Gateway throttling.

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

- **Body:** Binary PDF content (up to 100 pages; truncated if more).

**Notes:**
- If the rendered PDF exceeds 100 pages, it is automatically truncated to the first 100 pages:
  - `X-PDF-Pages: 100`
  - `X-PDF-Truncated: true`

#### 1.4.2 Error Responses

Common error statuses:

- `400 Bad Request`
  - Invalid/missing `input_type`
  - Missing/empty content field
  - Both `html` and `markdown` provided
  - Wrong content field for given `input_type`
  - Content type mismatch
  - Input size exceeds limit

- `401 Unauthorized`
  - Missing or invalid JWT

- `403 Forbidden`
  - Account not found (`ACCOUNT_NOT_FOUND`)
  - Per-user rate limit exceeded for free tier (`RATE_LIMIT_EXCEEDED`)
  - Free tier quota exhausted (`QUOTA_EXCEEDED`)

- `429 Too Many Requests`
  - Global API Gateway or WAF IP throttling triggered (from API Gateway/WAF, not Lambda).

- `500 Internal Server Error`
  - Unexpected server-side failure (Chromium, Puppeteer, or infrastructure issues).

For full error payload examples and codes, see `ERRORS.md`.

---

## 2. `GET /jobs`

**Description:**  
List jobs for the authenticated user (dashboard endpoint).

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

**Method:** `GET`  
**Path:** `/jobs`  
**Query Parameters:**
- `limit` (number, optional): Maximum number of jobs to return. Default: `50`, Max: `100`.
- `next_token` (string, optional): Pagination token from previous response.
- `status` (string, optional): Filter by status. Values: `"success"`, `"failure"`, or omit for all.
- `truncated` (boolean, optional): Filter by truncation status. `true` to show only truncated jobs, `false` for non-truncated, omit for all.

### 2.3 Response

#### 2.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "jobs": [
    {
      "job_id": "9f0a4b78-2c0c-4d14-9b8b-123456789abc",
      "status": "success",
      "mode": "html",
      "pages": 42,
      "truncated": false,
      "created_at": "2025-12-21T10:30:00Z",
      "completed_at": "2025-12-21T10:30:05Z"
    },
    {
      "job_id": "8e1b5c89-3d1d-5e25-ac9c-234567890def",
      "status": "success",
      "mode": "markdown",
      "pages": 100,
      "truncated": true,
      "created_at": "2025-12-21T09:15:00Z",
      "completed_at": "2025-12-21T09:15:12Z"
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
- `job_id` (string): UUID of the job.
- `status` (string): `"success"` or `"failure"`.
- `mode` (string): `"html"` or `"markdown"`.
- `pages` (number): Number of pages in the returned PDF.
- `truncated` (boolean): `true` if PDF was truncated to 100 pages.
- `created_at` (string): ISO 8601 timestamp.
- `completed_at` (string): ISO 8601 timestamp.
- `error_message` (string, optional): Present if `status` is `"failure"`.

#### 2.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

---

## 3. `POST /accounts`

**Description:**  
Create a new user account in the system.

### 3.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- Account must not already exist in `Users`.

### 3.2 HTTP Request

**Method:** `POST`  
**Path:** `/accounts`  
**Content-Type:** `application/json`

#### 3.2.1 Request Body

```json
{
  "plan_id": "free-basic"
}
```

**Fields:**
- `plan_id` (string, optional): Plan ID to assign. Defaults to the default free plan if not provided.

### 3.3 Response

#### 3.3.1 Success Response

- **Status:** `201 Created`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "user_sub": "12345678-1234-1234-1234-123456789012",
  "plan_id": "free-basic",
  "account_status": "free",
  "total_pdf_count": 0,
  "created_at": "2025-12-21T10:00:00Z"
}
```

#### 3.3.2 Error Responses

- `400 Bad Request` – Invalid `plan_id` or account already exists.
- `401 Unauthorized` – Missing or invalid JWT.
- `409 Conflict` – Account already exists (`ACCOUNT_ALREADY_EXISTS`).
- `500 Internal Server Error` – Server-side failure.

---

## 4. `GET /accounts/me`

**Description:**  
Get information about the authenticated user's account.

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
**Path:** `/accounts/me`

### 4.3 Response

#### 4.3.1 Success Response

- **Status:** `200 OK`
- **Content-Type:** `application/json`
- **Body:**

```json
{
  "user_sub": "12345678-1234-1234-1234-123456789012",
  "plan_id": "free-basic",
  "account_status": "free",
  "total_pdf_count": 42,
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
- `user_sub` (string): User identifier from Cognito.
- `plan_id` (string): Current plan ID.
- `account_status` (string): `"free"` or `"paid"`.
- `total_pdf_count` (number): All-time PDF count for the user.
- `created_at` (string): ISO 8601 timestamp.
- `upgraded_at` (string, optional): ISO 8601 timestamp when upgraded to paid plan.
- `plan` (object): Full plan configuration from `Plans` table.

#### 4.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

---

## 5. `DELETE /accounts/me`

**Description:**  
Delete the authenticated user's account and all associated data.

### 5.1 Authentication

- **Type:** JWT Bearer Token (Amazon Cognito)
- **Header:**

```http
Authorization: Bearer <jwt_token>
```

**Requirements:**
- Token must be valid and not expired.
- User account must exist in `Users`.

### 5.2 HTTP Request

**Method:** `DELETE`  
**Path:** `/accounts/me`

### 5.3 Response

#### 5.3.1 Success Response

- **Status:** `204 No Content`
- **Body:** Empty

**Note:** This permanently deletes:
- User account from `Users` table
- All job records from `JobDetails` table (via `user_sub`)
- All rate limit records from `UserRateLimits` table (via `user_sub`)
- Analytics records are not deleted (they don't contain user information)

#### 5.3.2 Error Responses

- `401 Unauthorized` – Missing or invalid JWT.
- `403 Forbidden` – Account not found (`ACCOUNT_NOT_FOUND`).
- `500 Internal Server Error` – Server-side failure.

---

## 6. Health Check (Optional, Internal)

> **Note:** This endpoint is optional and not required for the public MVP. It is recommended for internal monitoring.

**Method:** `GET`  
**Path:** `/health` (could be internal-only or protected)

### 6.1 Purpose

- Verify that the Lambda function is reachable and basic dependencies are responsive (e.g., quick check to DynamoDB).

### 6.2 Response (Example)

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


