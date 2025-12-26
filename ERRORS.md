## PodPDF API Error Reference

This document lists all error codes returned by the PodPDF API, their HTTP status codes, when they occur, and example responses.

---

### 1. Validation Errors (400 Bad Request)

#### `INVALID_INPUT_TYPE`
- **HTTP Status:** 400
- **When:** `input_type` is missing or not one of `"html"` or `"markdown"`.

#### `MISSING_INPUT_TYPE`
- **HTTP Status:** 400
- **When:** `input_type` field is not present in the request body.

#### `MISSING_CONTENT_FIELD`
- **HTTP Status:** 400
- **When:** Required content field (`html` or `markdown`) is missing based on `input_type`.

#### `EMPTY_CONTENT_FIELD`
- **HTTP Status:** 400
- **When:** Required content field is present but empty.

#### `CONFLICTING_FIELDS`
- **HTTP Status:** 400
- **When:** Both `html` and `markdown` fields are provided in the same request.

#### `WRONG_FIELD_PROVIDED`
- **HTTP Status:** 400
- **When:** Content field that does not match `input_type` is provided (e.g., `html` with `input_type: "markdown"`).

#### `CONTENT_TYPE_MISMATCH`
- **HTTP Status:** 400
- **When:** Content does not match declared `input_type` based on starting tags (e.g., HTML content with `input_type: "markdown"`).

#### `INPUT_SIZE_EXCEEDED`
- **HTTP Status:** 400
- **When:** Request body exceeds the maximum allowed input size (~5 MB).

---

### 2. Authentication & Account Errors

#### `UNAUTHORIZED`
- **HTTP Status:** 401
- **When:** JWT token is missing, invalid, or expired.

#### `ACCOUNT_NOT_FOUND`
- **HTTP Status:** 403
- **When:** No `Users` record exists for the authenticated `sub`. User must create an account before using the API.

---

### 3. Rate Limiting & Quota Errors

#### `RATE_LIMIT_EXCEEDED`
- **HTTP Status:** 403
- **When:** Free tier user exceeds the per-user rate limit (20 requests/minute).
- **Notes:** Returned by Lambda.

#### `QUOTA_EXCEEDED`
- **HTTP Status:** 403
- **When:** Free tier user has reached the all-time quota of 100 PDFs and must upgrade to a paid plan.
- **Notes:** Returned by Lambda.

**Example Response:**
```json
{
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "All-time quota of 100 PDFs has been reached. Please upgrade to a paid plan to continue using the service.",
    "details": {
      "current_usage": 100,
      "quota": 100,
      "quota_exceeded": true,
      "action_required": "upgrade_to_paid_plan"
    }
  }
}
```

**Fields:**
- `current_usage` (number): Current all-time PDF count for the user.
- `quota` (number): Quota limit (100 for free tier).
- `quota_exceeded` (boolean): Always `true` when this error is returned. Indicates the user has exceeded their quota.
- `action_required` (string): Action the user must take (`"upgrade_to_paid_plan"`).

---

### 4. Throttling Errors (Upstream)

#### `TooManyRequests` (API Gateway)
- **HTTP Status:** 429
- **When:**
  - Global API Gateway throttling is hit (1000 requests/second, 2000 burst), or
  - API Gateway throttling limit is reached.
- **Notes:**
  - Returned by API Gateway before the request reaches Lambda.
  - Error body is controlled by AWS, not PodPDF.

---

### 5. Server Errors

#### `INTERNAL_SERVER_ERROR`
- **HTTP Status:** 500
- **When:** Unexpected error occurs during processing (e.g., Chromium launch failure, PDF generation error, DynamoDB outage).
- **Notes:** Should be logged with full context in CloudWatch; response to clients is generic.

---

### 6. Error Code Summary Table

| Code                   | HTTP Status | Category                    | Description                                                   |
|------------------------|------------|-----------------------------|---------------------------------------------------------------|
| `INVALID_INPUT_TYPE`   | 400        | Validation                  | `input_type` invalid                                         |
| `MISSING_INPUT_TYPE`   | 400        | Validation                  | `input_type` missing                                         |
| `MISSING_CONTENT_FIELD`| 400        | Validation                  | Required content field missing                               |
| `EMPTY_CONTENT_FIELD`  | 400        | Validation                  | Required content field empty                                 |
| `CONFLICTING_FIELDS`   | 400        | Validation                  | Both `html` and `markdown` provided                          |
| `WRONG_FIELD_PROVIDED` | 400        | Validation                  | Wrong content field for given `input_type`                   |
| `CONTENT_TYPE_MISMATCH`| 400        | Validation                  | Content does not match declared `input_type`                 |
| `INPUT_SIZE_EXCEEDED`  | 400        | Validation                  | Input exceeds maximum allowed size                           |
| `PAGE_LIMIT_EXCEEDED`  | 400        | Validation                  | PDF page count exceeds maximum allowed pages                 |
| `UNAUTHORIZED`         | 401        | Authentication              | Missing/invalid JWT                                          |
| `ACCOUNT_NOT_FOUND`    | 403        | Account                     | User account not found                                       |
| `RATE_LIMIT_EXCEEDED`  | 403        | Rate limiting (per-user)    | Free tier per-user rate limit exceeded                       |
| `QUOTA_EXCEEDED`       | 403        | Quota                       | Free tier PDF quota exhausted                                |
| `TooManyRequests`      | 429        | Throttling (API Gateway)     | Global throttling triggered                                  |
| `INTERNAL_SERVER_ERROR`| 500        | Server                      | Unexpected server-side error                                 |


