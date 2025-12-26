# Test Jobs Endpoints

This document contains sample requests for the jobs endpoints: `GET /jobs/{job_id}` and `GET /jobs`.

## Request Details

**Authentication:** JWT Bearer Token required  
**Content-Type:** `application/json`

---

## 1. Get Specific Job - `GET /jobs/{job_id}`

Get status and details of a specific job by its ID.

### 1.1 Basic Request

#### cURL Command

```bash
curl -X GET https://YOUR_API_URL/jobs/9f0a4b78-2c0c-4d14-9b8b-123456789abc \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Expected Response (QuickJob - Completed)

**Status Code:** `200 OK`

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

#### Expected Response (LongJob - Queued)

**Status Code:** `200 OK`

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

#### Expected Response (LongJob - Completed)

**Status Code:** `200 OK`

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

#### Expected Response (LongJob - Failed)

**Status Code:** `200 OK`

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

#### Error Response (Job Not Found)

**Status Code:** `404 Not Found`

```json
{
  "error": {
    "code": "JOB_NOT_FOUND",
    "message": "Job not found or does not belong to authenticated user"
  }
}
```

---

## 2. List Jobs - `GET /jobs`

List all jobs for the authenticated user with optional filtering and pagination.

### 2.1 Basic Request (All Jobs)

#### cURL Command

```bash
curl -X GET https://YOUR_API_URL/jobs \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### Expected Response

**Status Code:** `200 OK`

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

### 2.2 Filter by Status

#### cURL Command (Only Completed Jobs)

```bash
curl -X GET "https://YOUR_API_URL/jobs?status=completed" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### cURL Command (Only Failed Jobs)

```bash
curl -X GET "https://YOUR_API_URL/jobs?status=failed" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### cURL Command (Only Queued Jobs)

```bash
curl -X GET "https://YOUR_API_URL/jobs?status=queued" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Valid status values:** `queued`, `processing`, `completed`, `failed`, `timeout`

### 2.3 Filter by Job Type

#### cURL Command (Only Quick Jobs)

```bash
curl -X GET "https://YOUR_API_URL/jobs?job_type=quick" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### cURL Command (Only Long Jobs)

```bash
curl -X GET "https://YOUR_API_URL/jobs?job_type=long" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### 2.4 Filter by Multiple Parameters

#### cURL Command (Completed Quick Jobs)

```bash
curl -X GET "https://YOUR_API_URL/jobs?status=completed&job_type=quick" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### cURL Command (Failed Long Jobs)

```bash
curl -X GET "https://YOUR_API_URL/jobs?status=failed&job_type=long" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### 2.5 Pagination

#### cURL Command (First Page - Limit 10)

```bash
curl -X GET "https://YOUR_API_URL/jobs?limit=10" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### cURL Command (Next Page - Using next_token)

```bash
curl -X GET "https://YOUR_API_URL/jobs?limit=10&next_token=eyJ1c2VyX3N1YiI6IjEyMzQ1NiIsImNyZWF0ZWRfYXQiOiIyMDI1LTEyLTIxVDA5OjE1OjAwWiJ9" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Pagination Parameters:**
- `limit` (number, optional): Maximum number of jobs to return. Default: `50`, Max: `100`
- `next_token` (string, optional): Token from previous response to get next page

### 2.6 Combined Filters with Pagination

#### cURL Command (Completed Long Jobs, Limit 20)

```bash
curl -X GET "https://YOUR_API_URL/jobs?status=completed&job_type=long&limit=20" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

#### cURL Command (All Quick Jobs, Limit 5, Next Page)

```bash
curl -X GET "https://YOUR_API_URL/jobs?job_type=quick&limit=5&next_token=YOUR_NEXT_TOKEN_HERE" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## 3. Query Parameters Summary

### For `GET /jobs`:

| Parameter | Type | Required | Values | Description |
|-----------|------|----------|--------|-------------|
| `limit` | number | No | 1-100 | Maximum number of jobs to return (default: 50) |
| `next_token` | string | No | - | Pagination token from previous response |
| `status` | string | No | `queued`, `processing`, `completed`, `failed`, `timeout` | Filter by job status |
| `job_type` | string | No | `quick`, `long` | Filter by job type |
| `truncated` | boolean | No | `true`, `false` | Filter by truncation status (legacy, always `false` for new jobs) |

---

## 4. Testing Notes

1. **Replace placeholders:**
   - `YOUR_API_URL` - Your API Gateway URL (e.g., `https://abc123.execute-api.eu-central-1.amazonaws.com`)
   - `YOUR_JWT_TOKEN` - A valid JWT token from Cognito
   - `9f0a4b78-2c0c-4d14-9b8b-123456789abc` - A valid job ID from your account

2. **Getting a Job ID:**
   - After submitting a `/quickjob` or `/longjob` request, you'll receive a `job_id` in the response
   - Use this `job_id` to check the status with `GET /jobs/{job_id}`

3. **Pagination:**
   - If the response includes a `next_token`, there are more results available
   - Use the `next_token` in the next request to get the next page
   - If `next_token` is `null` or missing, you've reached the end

4. **Filtering:**
   - Multiple filters can be combined (e.g., `?status=completed&job_type=quick`)
   - Filters are case-sensitive
   - Invalid filter values will be ignored or return empty results

5. **Job Ownership:**
   - You can only access jobs that belong to your authenticated user account
   - Attempting to access another user's job will return `404 Not Found`

6. **Response Fields:**
   - Quick jobs: Include `timeout_occurred` field
   - Long jobs: Include `s3_url`, `s3_url_expires_at`, `webhook_delivered`, `webhook_delivered_at`, `webhook_retry_count`
   - Completed jobs: Include `pages` and `completed_at`
   - Failed jobs: Include `error_message`

---

## 5. Example Workflow

### Step 1: Submit a Long Job

```bash
curl -X POST https://YOUR_API_URL/longjob \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "input_type": "html",
    "html": "<!DOCTYPE html><html><body><h1>Test</h1></body></html>",
    "webhook_url": "https://your-webhook-url.com/webhook"
  }'
```

**Response:**
```json
{
  "job_id": "8e1b5c89-3d1d-5e25-ac9c-234567890def",
  "status": "queued",
  "message": "Job queued for processing",
  "estimated_completion": "2025-12-21T10:35:00Z"
}
```

### Step 2: Check Job Status

```bash
curl -X GET https://YOUR_API_URL/jobs/8e1b5c89-3d1d-5e25-ac9c-234567890def \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Step 3: List All Your Jobs

```bash
curl -X GET https://YOUR_API_URL/jobs \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Step 4: Filter for Completed Long Jobs

```bash
curl -X GET "https://YOUR_API_URL/jobs?status=completed&job_type=long" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

