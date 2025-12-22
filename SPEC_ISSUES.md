# Spec Review - Issues and Inconsistencies

## Critical Issues

### 1. Input Type Detection Inconsistency ✅ RESOLVED
**Location:** Line 183 in Data Flow section
**Issue:** References `input_type` field, but request body (line 217-218) shows `html` and `markdown` as separate fields. No `input_type` field exists.
**Fix Applied:** 
- Added `input_type` field to request body (required, must be "html" or "markdown")
- Added validation that checks starting tags to ensure content matches declared type
- Updated request body examples to include `input_type`
- Added comprehensive error responses for validation failures

### 2. WAF Title Confusion ✅ RESOLVED
**Location:** Line 321 - "Per-IP Protection (WAF - Free Tier Only)"
**Issue:** Title says "Free Tier Only" but description (line 398) says "applies to all users"
**Fix Applied:** 
- Clarified that "Free Tier" refers to AWS WAF pricing tier (not user pricing tier)
- Updated all WAF references to specify "AWS Free Tier Features" 
- Made explicit that WAF applies to all users (both free tier and paid tier users)
- Updated title to: "Per-IP Protection (WAF - AWS Free Tier Features)"

### 3. Pricing Model Ambiguity ✅ RESOLVED
**Location:** Lines 356, 364, 371
**Issue:** Unclear if free tier users can:
- Continue using service after 100 PDFs by paying $0.005 per PDF, OR
- Must upgrade to a paid plan first, then pay $0.005 per PDF
**Fix Applied:**
- Clarified that free tier users must upgrade to paid plan after 100 PDFs (no pay-per-PDF option for free tier)
- Paid plan users have unlimited PDFs, billed at $0.005 per PDF
- Usage is tracked and invoiced monthly for paid plan users
- Updated error messages to indicate upgrade is required

### 4. Paid Tier Quota Not Specified ✅ RESOLVED
**Location:** Line 364, 329
**Issue:** Spec says paid tier has "unlimited rate" but doesn't clarify:
- Do paid tier users have unlimited PDFs? 
- Or do they pay $0.005 per PDF with no quota limit?
**Fix Applied:**
- Clarified that paid plan users have unlimited PDFs (no quota limit)
- They pay $0.005 per PDF, invoiced monthly
- Rate limits are unlimited for paid plan users (only limited by WAF and API Gateway)

### 5. Request Validation Missing ✅ RESOLVED
**Location:** Request Body section (line 213-233)
**Issue:** No specification for:
- What happens if both `html` AND `markdown` are provided?
- What happens if neither is provided?
- What happens if both are empty strings?
**Fix Applied:**
- Added validation: Return 400 if both `html` and `markdown` fields are present
- Added validation: Return 400 if `input_type` is missing or invalid
- Added validation: Return 400 if the required content field (based on `input_type`) is missing or empty
- Added validation: Return 400 if wrong field is provided (e.g., `html` field when `input_type` is `"markdown"`)
- Added comprehensive error response examples for all validation scenarios

### 6. Error Response Codes Not Specific Enough ✅ RESOLVED
**Location:** Line 259 - "403 | Forbidden - Rate limit exceeded or quota exhausted"
**Issue:** Doesn't distinguish between:
- Free tier per-user rate limit (20/min)
- WAF IP rate limit (2000/5min)
- Quota exhaustion (100 PDFs)
**Fix Applied:**
- Added specific error codes: `RATE_LIMIT_EXCEEDED` (per-user rate limit) and `QUOTA_EXCEEDED` (PDF quota)
- Clarified that WAF IP rate limits return 429 (from API Gateway/WAF), not 403
- Updated 403 error description to distinguish between rate limit and quota exhaustion
- Added note explaining which error codes come from Lambda (403) vs API Gateway/WAF (429)
- Error codes now clearly distinguish between different rate limit types

## Minor Issues

### 7. Missing Error Response Examples ✅ RESOLVED
**Location:** Error Response Format section (line 263-276)
**Issue:** Only shows `QUOTA_EXCEEDED` example, but there are other error types
**Fix Applied:** 
- Added common rate limit error format
- Added page limit exceeded error example
- All error types now have example responses

### 8. Page Count Estimation Not Specified ✅ RESOLVED
**Location:** Line 177 - "Estimates page count/complexity from input"
**Issue:** How is page count estimated? Before or after rendering? What's the algorithm?
**Fix Applied:**
- Removed estimation approach
- Changed to actual page count after PDF rendering
- Page count is determined from the rendered PDF (not estimated)
- If PDF exceeds 100 pages after rendering, it is automatically truncated to the first 100 pages (not rejected)
- Response includes `X-PDF-Truncated` and `X-PDF-Pages` headers to indicate truncation
- This ensures accurate page counting based on actual rendered output and provides a better user experience than rejection

### 9. Cognito Plan Management Unclear ✅ RESOLVED
**Location:** Line 99 - "Groups or custom attributes for pricing tiers"
**Issue:** Not specified which method is used, or how the Lambda determines user tier
**Fix Applied:**
- Plan information is now stored in DynamoDB `Users` table (`plan` attribute)
- Plan is not stored in Cognito (Cognito only handles authentication)
- Lambda reads `plan` attribute from DynamoDB on each request
- Default plan is `"free"` when user record is first created
- Plan upgrade updates `plan` attribute to `"paid"` in DynamoDB
- Added `upgraded_at` timestamp field to track when plan was upgraded

### 10. DynamoDB TTL Not Specified for Users ✅ RESOLVED
**Location:** Line 108-112 - Users table
**Issue:** No TTL specified, but UserRateLimits has TTL. Should Users have TTL for cleanup?
**Fix Applied:**
- Users table: No TTL (permanent storage for user records)
- Added JobDetails table with TTL (2-3 months) for job tracking
- Added Analytics table (no TTL, long-term analytics storage)
- Clarified TTL usage: UserRateLimits (1 hour), JobDetails (2-3 months), Users (permanent), Analytics (permanent)

### 11. API Gateway Payload Format
**Location:** Line 75 - "Payload Format: 2.0 (binary PDF support)"
**Issue:** HTTP API v2 doesn't use "Payload Format" terminology. This might be confusing.
**Fix Needed:** Clarify that HTTP API v2 supports binary responses natively

### 12. Missing CORS Configuration Details ✅ RESOLVED
**Location:** Line 76 - "CORS: Enabled"
**Issue:** No details on which origins are allowed, headers, methods
**Fix Applied:**
- Added comprehensive CORS configuration section to DEPLOYMENT.md
- Includes allowed origins, headers, methods, credentials, and max age settings
- Provides separate configurations for development and production environments
- Includes security best practices (no wildcard origins in production)

## Suggestions for Clarity

### 13. Add Request Validation Flow ✅ RESOLVED
Consider adding a dedicated "Request Validation" section that clearly outlines:
- Field presence checks
- Content validation
- Size limits
- Error responses for each validation failure
**Fix Applied:**
- Added comprehensive "Request Validation" section to API Specification
- Outlines validation order: Authentication → Account → Request Body → Business Logic
- Added account validation requirement (all users must have an account, no auto-creation)
- Added `ACCOUNT_NOT_FOUND` error code and response example
- Updated validation phase to require existing account
- Updated implementation details to reflect account requirement

### 14. Clarify Billing Flow ✅ RESOLVED
Add a section explaining:
- How free tier users transition to paid usage
- Whether they can pay per PDF or must upgrade
- How billing is tracked and enforced
**Fix Applied:**
- Introduced `plan_id` and `account_status` fields on `Users` table
- Added `Plans` table to define all plan configurations (free and paid)
- Clarified that free users must upgrade to a paid plan after 100 PDFs
- Clarified that paid plan users pay per PDF based on `price_per_pdf` from `Plans`
- Updated Implementation Details to describe how Lambda reads plan config and enforces quotas/pricing

### 15. Add Error Code Reference Table ✅ RESOLVED
Create a comprehensive table of all error codes with:
- Code
- HTTP Status
- When it occurs
- Example response
**Fix Applied:**
- Created `ERRORS.md` as a dedicated error reference document
- Documented all error codes (validation, auth/account, rate limiting, throttling, server errors)
- Added a summary table with code, HTTP status, category, and description
- Clarified which errors are returned by Lambda vs API Gateway/WAF

