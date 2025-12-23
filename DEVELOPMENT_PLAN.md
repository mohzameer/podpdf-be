# PodPDF Development Plan

**Version:** 1.0.0  
**Date:** December 21, 2025  
**Approach:** Environment setup first, then endpoint-by-endpoint development with testing

---

## Table of Contents

1. [Development vs Production Stacks](#development-vs-production-stacks)
2. [Development Environment Setup](#development-environment-setup)
3. [Project Structure](#project-structure)
4. [Endpoint Development Order](#endpoint-development-order)
5. [Testing Strategy](#testing-strategy)
6. [Development Workflow](#development-workflow)

---

## Development vs Production Stacks

### Overview

**Dev and Prod are completely separate AWS stacks** - they do not share any resources. The Serverless Framework uses the `--stage` parameter to deploy separate CloudFormation stacks.

### Development Stack (`podpdf-dev`)

- **Stack Name:** `podpdf-dev`
- **Purpose:** Development, testing, and iteration
- **Resources:**
  - DynamoDB tables: `podpdf-dev-users`, `podpdf-dev-user-rate-limits`, `podpdf-dev-job-details`, `podpdf-dev-analytics`, `podpdf-dev-plans`
  - Lambda function: `podpdf-dev-generate`
  - API Gateway: `podpdf-dev-api`
  - Cognito User Pool: `podpdf-dev-user-pool`
  - WAF: Basic rate-based rule
- **Configuration:**
  - Lower throttling: 100 req/sec (vs 1000 in prod)
  - Debug-level logging
  - Lower cost alert thresholds
  - Test user pool (separate from production)
- **Deployment:**
  ```bash
  serverless deploy --stage dev
  ```

### Production Stack (`podpdf-prod`)

- **Stack Name:** `podpdf-prod`
- **Purpose:** Live production environment
- **Resources:**
  - DynamoDB tables: `podpdf-prod-users`, `podpdf-prod-user-rate-limits`, `podpdf-prod-job-details`, `podpdf-prod-analytics`, `podpdf-prod-plans`
  - Lambda function: `podpdf-prod-generate`
  - API Gateway: `podpdf-prod-api`
  - Cognito User Pool: `podpdf-prod-user-pool`
  - WAF: Basic rate-based rule
- **Configuration:**
  - Higher throttling: 1000 req/sec with 2000 burst
  - Info-level logging (optimized)
  - Production cost alert thresholds
  - Production user pool (separate from dev)
- **Deployment:**
  ```bash
  serverless deploy --stage prod
  ```

### Key Points

1. **Complete Isolation:** Dev and prod stacks are completely independent
   - Separate DynamoDB tables (no data sharing)
   - Separate Cognito user pools (separate users)
   - Separate API endpoints (different URLs)
   - Separate Lambda functions

2. **Development Workflow:**
   - All development happens in the `dev` stack
   - Test each endpoint in `dev` before moving to the next
   - Only deploy to `prod` after all endpoints are complete and tested in `dev`

3. **Same Codebase, Different Config:**
   - Same `serverless.yml` file
   - Same source code
   - Different stage-specific configurations (throttling, logging, etc.)
   - Stage determined by `--stage` flag or `STAGE` environment variable

4. **Region:**
   - Both stacks deploy to `eu-central-1` (Frankfurt)
   - Can be in same AWS account or separate accounts (recommended for production)

### Deployment Commands

```bash
# Deploy to development
serverless deploy --stage dev

# Deploy to production (only after dev is tested)
serverless deploy --stage prod

# View dev stack info
serverless info --stage dev

# View prod stack info
serverless info --stage prod

# Remove dev stack (if needed)
serverless remove --stage dev

# Remove prod stack (use with extreme caution!)
serverless remove --stage prod
```

---

## Development Environment Setup

### Phase 1: Prerequisites Installation

**Goal:** Ensure all required tools and dependencies are installed and configured.

#### 1.1 Node.js and Package Manager
- [ ] Install Node.js 20.x
  ```bash
  node --version  # Verify v20.x
  ```
- [ ] Initialize npm project (if not already done)
  ```bash
  npm init -y
  ```
- [ ] Install Serverless Framework globally
  ```bash
  npm install -g serverless@latest
  serverless --version  # Verify 3.x+
  ```

#### 1.2 AWS Configuration
- [ ] Install AWS CLI
  ```bash
  aws --version
  ```
- [ ] Configure AWS credentials
  ```bash
  aws configure
  # Set: Access Key ID, Secret Access Key, Region (eu-central-1), Output format (json)
  ```
- [ ] Verify AWS access
  ```bash
  aws sts get-caller-identity
  ```

#### 1.3 Project Dependencies
- [ ] Install core dependencies
  ```bash
  npm install @sparticuz/chromium puppeteer-core marked
  ```
- [ ] Install development dependencies
  ```bash
  npm install --save-dev @types/node typescript ts-node
  ```
- [ ] Install Serverless plugins (optional - only if using .env files)
  ```bash
  npm install --save-dev serverless-dotenv-plugin
  ```
  **Note:** This is only needed if you want to use `.env` files. For this project, environment variables are set directly in `serverless.yml`.

### Phase 2: Project Structure Setup

**Goal:** Create the basic project structure and configuration files.

#### 2.1 Directory Structure
- [ ] Create directory structure
  ```
  podpdf-be/
  ├── src/
  │   ├── handlers/
  │   │   ├── generate.js
  │   │   ├── jobs.js
  │   │   ├── accounts.js
  │   │   └── health.js
  │   ├── services/
  │   │   ├── auth.js
  │   │   ├── pdf.js
  │   │   ├── dynamodb.js
  │   │   ├── rateLimit.js
  │   │   └── validation.js
  │   ├── utils/
  │   │   ├── errors.js
  │   │   └── logger.js
  │   └── middleware/
  │       └── auth.js
  ├── serverless.yml
  ├── resources.yml
  ├── package.json
  └── .gitignore
  ```

#### 2.2 Configuration Files
- [ ] Create `serverless.yml` with basic structure
  - Provider configuration (Node.js 20.x, region, memory, timeout)
  - Environment variables for dev/prod (set directly in serverless.yml)
  - HTTP API configuration
  - Function placeholders for all endpoints
  - CORS configuration
  - Stage-specific custom configuration (throttling, logging levels)
- [ ] Create `resources.yml` with AWS resources
  - DynamoDB tables (Users, UserRateLimits, JobDetails, Analytics, Plans)
  - Cognito User Pool and App Client
  - WAF configuration (basic rate-based rule)
  - IAM roles and policies
- [ ] Create `.gitignore` (exclude node_modules, .env files, .serverless)

**Note on Environment Variables:**

Environment variables are configured **directly in `serverless.yml`** using stage-specific configuration. The `--stage` flag determines which values are used:

**Example `serverless.yml` structure:**
```yaml
provider:
  stage: ${opt:stage, 'dev'}  # Defaults to 'dev' if not specified
  environment:
    STAGE: ${self:provider.stage}  # Automatically set to 'dev' or 'prod'
    LOG_LEVEL: ${self:custom.stages.${self:provider.stage}.logLevel}
    FREE_TIER_QUOTA: 100
    MAX_PAGES: 100
    MAX_INPUT_SIZE_MB: 5

custom:
  stages:
    dev:
      logLevel: debug
      throttling:
        rate: 100
        burst: 200
    prod:
      logLevel: info
      throttling:
        rate: 1000
        burst: 2000
```

**How it works:**
- When you run `serverless deploy --stage dev`, the `dev` stage configuration is used
- When you run `serverless deploy --stage prod`, the `prod` stage configuration is used
- Environment variables are automatically injected into Lambda functions at deployment time
- **No `.env` files needed** - everything is in `serverless.yml`

**When would you use `.env` files?**
- Only if you have secrets that shouldn't be in version control (but prefer AWS Secrets Manager)
- Per-developer local overrides (not needed since we're not developing offline)
- External service credentials (can be in `serverless.yml` or AWS Secrets Manager)

**For this MVP:** All environment variables can be set directly in `serverless.yml` - no `.env` files required.

#### 2.3 Utility Modules
- [ ] Create `src/utils/errors.js` - Error response formatting
- [ ] Create `src/utils/logger.js` - Logging utility
- [ ] Create `src/services/dynamodb.js` - DynamoDB client and helper functions
- [ ] Create `src/middleware/auth.js` - JWT authentication middleware

### Phase 3: AWS Resources Setup (Dev Stack)

**Goal:** Deploy infrastructure resources to AWS development stack (`podpdf-dev`).

**Note:** This deploys the **development stack only**. The production stack (`podpdf-prod`) will be deployed later after all development and testing is complete.

#### 3.1 Initial Deployment
- [ ] Deploy base infrastructure to dev stack (DynamoDB tables, Cognito, IAM roles)
  ```bash
  serverless deploy --stage dev
  ```
  This creates:
  - CloudFormation stack: `podpdf-dev`
  - DynamoDB tables: `podpdf-dev-users`, `podpdf-dev-user-rate-limits`, `podpdf-dev-job-details`, `podpdf-dev-analytics`, `podpdf-dev-plans`
  - Cognito User Pool: `podpdf-dev-user-pool`
  - Lambda function: `podpdf-dev-generate`
  - API Gateway: `podpdf-dev-api`
- [ ] Verify DynamoDB tables created (should see `podpdf-dev-*` tables)
  ```bash
  aws dynamodb list-tables --region eu-central-1
  ```
- [ ] Verify Cognito User Pool created (should see `podpdf-dev-user-pool`)
  ```bash
  aws cognito-idp list-user-pools --max-results 10 --region eu-central-1
  ```
- [ ] Get dev API endpoint URL
  ```bash
  serverless info --stage dev
  ```

#### 3.2 Seed Data
- [ ] Create seed script for `Plans` table
  - Insert default free plan (`free-basic`)
  - Insert default paid plan (`paid-standard`)
- [ ] Run seed script
  ```bash
  node scripts/seed-plans.js --stage dev
  ```

#### 3.3 Test User Creation
- [ ] Create test user in Cognito (via AWS Console or CLI)
- [ ] Verify JWT token generation
- [ ] Test JWT validation after first endpoint deployment

---

## Endpoint Development Order

Endpoints will be developed in this order to allow incremental testing and dependency management:

### Endpoint 1: `POST /accounts` (Account Creation)

**Priority:** High (required for other endpoints)  
**Dependencies:** DynamoDB Users table, Cognito JWT validation

#### Development Steps:
1. **Handler Implementation**
   - [ ] Create `src/handlers/accounts.js`
   - [ ] Implement account creation logic
   - [ ] Validate JWT token
   - [ ] Check if account already exists
   - [ ] Create user record in DynamoDB Users table
   - [ ] Assign default plan (`free-basic`)
   - [ ] Return 201 response with user data

2. **Service Layer**
   - [ ] Create `src/services/accounts.js`
   - [ ] Implement `createAccount(userSub, planId)`
   - [ ] Handle DynamoDB operations

3. **Validation**
   - [ ] Validate request body (`plan_id` optional)
   - [ ] Validate plan exists in Plans table
   - [ ] Check for duplicate account (409 Conflict)

4. **Error Handling**
   - [ ] 400 Bad Request (invalid plan_id)
   - [ ] 401 Unauthorized (invalid JWT)
   - [ ] 409 Conflict (account already exists)
   - [ ] 500 Internal Server Error

5. **Testing**
   - [ ] Test with valid JWT and new account
   - [ ] Test with existing account (should return 409)
   - [ ] Test with invalid JWT (should return 401)
   - [ ] Test with invalid plan_id (should return 400)
   - [ ] Verify DynamoDB record created correctly

6. **Deployment & Verification**
   - [ ] Deploy to dev environment
   - [ ] Test endpoint with Postman/curl
   - [ ] Verify CloudWatch logs
   - [ ] Mark endpoint as complete

---

### Endpoint 2: `GET /accounts/me` (Get Account Info)

**Priority:** High (needed for account management)  
**Dependencies:** DynamoDB Users table, DynamoDB Plans table, Cognito JWT validation

#### Development Steps:
1. **Handler Implementation**
   - [ ] Create handler in `src/handlers/accounts.js`
   - [ ] Implement account retrieval logic
   - [ ] Validate JWT token
   - [ ] Fetch user record from DynamoDB
   - [ ] Fetch plan details from Plans table
   - [ ] Combine and return account info

2. **Service Layer**
   - [ ] Implement `getAccount(userSub)` in `src/services/accounts.js`
   - [ ] Implement `getPlan(planId)` in `src/services/plans.js`

3. **Validation**
   - [ ] Validate JWT token
   - [ ] Check account exists (403 if not found)

4. **Error Handling**
   - [ ] 401 Unauthorized (invalid JWT)
   - [ ] 403 Forbidden (account not found)
   - [ ] 500 Internal Server Error

5. **Testing**
   - [ ] Test with valid JWT and existing account
   - [ ] Test with non-existent account (should return 403)
   - [ ] Test with invalid JWT (should return 401)
   - [ ] Verify response includes plan details

6. **Deployment & Verification**
   - [ ] Deploy to dev environment
   - [ ] Test endpoint with Postman/curl
   - [ ] Verify response structure matches spec
   - [ ] Mark endpoint as complete

---

### Endpoint 3: `POST /generate` (PDF Generation - HTML Only)

**Priority:** Highest (core functionality)  
**Dependencies:** DynamoDB (Users, UserRateLimits, JobDetails, Analytics), Cognito JWT, Puppeteer/Chromium

#### Development Steps:
1. **Handler Implementation**
   - [ ] Create `src/handlers/generate.js`
   - [ ] Implement basic request handling
   - [ ] Validate JWT token
   - [ ] Validate request body (HTML input only initially)

2. **Service Layer - Authentication & Authorization**
   - [ ] Implement `validateUser(userSub)` - check account exists
   - [ ] Implement `getUserPlan(userSub)` - fetch plan details

3. **Service Layer - Validation**
   - [ ] Create `src/services/validation.js`
   - [ ] Implement `validateInputType(inputType)`
   - [ ] Implement `validateHTMLContent(html)`
   - [ ] Implement `validateContentSize(content)`
   - [ ] Implement `validateContentType(content, inputType)`

4. **Service Layer - Rate Limiting**
   - [ ] Create `src/services/rateLimit.js`
   - [ ] Implement `checkRateLimit(userSub, plan)` - DynamoDB atomic counter
   - [ ] Handle free tier (20 req/min) vs paid tier (unlimited)

5. **Service Layer - Quota Management**
   - [ ] Implement `checkQuota(userSub, plan)` in `src/services/quota.js`
   - [ ] Check free tier quota (100 PDFs all-time)
   - [ ] Paid tier: no quota check

6. **Service Layer - PDF Generation**
   - [ ] Create `src/services/pdf.js`
   - [ ] Implement `generatePDF(html, options)` using Puppeteer
   - [ ] Configure Chromium layer
   - [ ] Implement page counting
   - [ ] Implement truncation to 100 pages if needed

7. **Service Layer - Job Tracking**
   - [ ] Create `src/services/jobs.js`
   - [ ] Implement `createJob(userSub, mode, status, pages, truncated)`
   - [ ] Write to JobDetails table
   - [ ] Write to Analytics table (no user info)

8. **Error Handling**
   - [ ] 400 Bad Request (validation errors)
   - [ ] 401 Unauthorized (invalid JWT)
   - [ ] 403 Forbidden (account not found, rate limit, quota exceeded)
   - [ ] 500 Internal Server Error (PDF generation failures)

9. **Testing - HTML Input**
   - [ ] Test with valid HTML and JWT
   - [ ] Test with invalid JWT (401)
   - [ ] Test with non-existent account (403)
   - [ ] Test rate limiting (free tier: 20 req/min)
   - [ ] Test quota enforcement (free tier: 100 PDFs)
   - [ ] Test with large HTML (size limit)
   - [ ] Test PDF generation (simple HTML)
   - [ ] Test PDF generation (complex HTML with images)
   - [ ] Test page truncation (>100 pages)
   - [ ] Verify response headers (X-PDF-Pages, X-PDF-Truncated, X-Job-Id)
   - [ ] Verify binary PDF response

10. **Deployment & Verification**
    - [ ] Deploy to dev environment
    - [ ] Test endpoint with Postman/curl
    - [ ] Verify PDF output quality
    - [ ] Check CloudWatch logs and metrics
    - [ ] Verify DynamoDB records (JobDetails, Analytics)
    - [ ] Mark HTML generation as complete

---

### Endpoint 4: `POST /generate` (Markdown Support)

**Priority:** High (core functionality extension)  
**Dependencies:** Markdown library (marked), HTML generation (already implemented)

#### Development Steps:
1. **Markdown Processing**
   - [ ] Implement `convertMarkdownToHTML(markdown)` in `src/services/pdf.js`
   - [ ] Use `marked` library for GitHub-flavored Markdown
   - [ ] Test markdown conversion (headings, lists, tables, code blocks)

2. **Validation Updates**
   - [ ] Update `validateContentType()` to handle markdown
   - [ ] Add markdown-specific validation (no HTML tags)

3. **Handler Updates**
   - [ ] Update `src/handlers/generate.js` to handle `input_type: "markdown"`
   - [ ] Route markdown input through conversion → HTML → PDF

4. **Testing - Markdown Input**
   - [ ] Test with valid markdown
   - [ ] Test markdown with tables
   - [ ] Test markdown with code blocks
   - [ ] Test markdown with images (URLs)
   - [ ] Test validation (markdown with HTML tags should fail)
   - [ ] Test both HTML and markdown in same endpoint

5. **Deployment & Verification**
   - [ ] Deploy to dev environment
   - [ ] Test markdown endpoint
   - [ ] Verify PDF output from markdown
    - [ ] Mark markdown support as complete

---

### Endpoint 5: `GET /jobs` (List Jobs)

**Priority:** Medium (dashboard functionality)  
**Dependencies:** DynamoDB JobDetails table, Cognito JWT validation

#### Development Steps:
1. **Handler Implementation**
   - [ ] Create `src/handlers/jobs.js`
   - [ ] Implement job listing logic
   - [ ] Validate JWT token
   - [ ] Query JobDetails table by user_sub

2. **Service Layer**
   - [ ] Create `src/services/jobs.js` (if not already created)
   - [ ] Implement `listJobs(userSub, limit, nextToken, status, truncated)`
   - [ ] Implement DynamoDB query with pagination
   - [ ] Implement filtering by status and truncated flag

3. **Pagination**
   - [ ] Implement `next_token` handling
   - [ ] Generate pagination token for next page
   - [ ] Limit results (default 50, max 100)

4. **Validation**
   - [ ] Validate query parameters (limit, status, truncated)
   - [ ] Validate JWT token
   - [ ] Check account exists

5. **Error Handling**
   - [ ] 401 Unauthorized (invalid JWT)
   - [ ] 403 Forbidden (account not found)
   - [ ] 500 Internal Server Error

6. **Testing**
   - [ ] Test with valid JWT and existing jobs
   - [ ] Test pagination (multiple pages)
   - [ ] Test filtering by status (success, failure)
   - [ ] Test filtering by truncated (true, false)
   - [ ] Test with no jobs (empty array)
   - [ ] Test with invalid JWT (401)
   - [ ] Test with non-existent account (403)

7. **Deployment & Verification**
   - [ ] Deploy to dev environment
   - [ ] Test endpoint with Postman/curl
   - [ ] Verify pagination works correctly
   - [ ] Verify filtering works correctly
   - [ ] Mark endpoint as complete

---

### Endpoint 6: `DELETE /accounts/me` (Delete Account)

**Priority:** Low (account management)  
**Dependencies:** DynamoDB (Users, JobDetails, UserRateLimits), Cognito JWT validation

#### Development Steps:
1. **Handler Implementation**
   - [ ] Add delete handler to `src/handlers/accounts.js`
   - [ ] Implement account deletion logic
   - [ ] Validate JWT token
   - [ ] Delete user record and related data

2. **Service Layer**
   - [ ] Implement `deleteAccount(userSub)` in `src/services/accounts.js`
   - [ ] Delete from Users table
   - [ ] Delete all JobDetails records (query by user_sub, batch delete)
   - [ ] Delete all UserRateLimits records (query by user_sub, batch delete)
   - [ ] Note: Analytics records are NOT deleted (privacy-focused)

3. **Validation**
   - [ ] Validate JWT token
   - [ ] Check account exists (403 if not found)

4. **Error Handling**
   - [ ] 401 Unauthorized (invalid JWT)
   - [ ] 403 Forbidden (account not found)
   - [ ] 500 Internal Server Error

5. **Testing**
   - [ ] Test with valid JWT and existing account
   - [ ] Verify user record deleted from Users table
   - [ ] Verify all JobDetails deleted
   - [ ] Verify all UserRateLimits deleted
   - [ ] Verify Analytics records remain (not deleted)
   - [ ] Test with non-existent account (403)
   - [ ] Test with invalid JWT (401)

6. **Deployment & Verification**
   - [ ] Deploy to dev environment
   - [ ] Test endpoint with Postman/curl
   - [ ] Verify data deletion in DynamoDB
   - [ ] Mark endpoint as complete

---

### Endpoint 7: `GET /health` (Health Check - Optional)

**Priority:** Low (monitoring)  
**Dependencies:** DynamoDB connection check

#### Development Steps:
1. **Handler Implementation**
   - [ ] Create `src/handlers/health.js`
   - [ ] Implement health check logic
   - [ ] Check DynamoDB connectivity
   - [ ] Return status and uptime

2. **Testing**
   - [ ] Test health endpoint
   - [ ] Verify DynamoDB check works

3. **Deployment & Verification**
   - [ ] Deploy to dev environment (optional, can be internal-only)
   - [ ] Mark endpoint as complete

---

## Testing Strategy

### Unit Testing
- [ ] Set up Jest or Mocha test framework
- [ ] Create unit tests for:
  - Validation functions
  - PDF generation (mock Puppeteer)
  - Rate limiting logic
  - Quota checking logic
  - Error handling

### Integration Testing
- [ ] Test each endpoint with real AWS services (dev environment)
- [ ] Test authentication flow
- [ ] Test DynamoDB operations
- [ ] Test PDF generation end-to-end

### Manual Testing
- [ ] Use Postman or curl for each endpoint
- [ ] Test error scenarios
- [ ] Test edge cases (large files, many pages, etc.)
- [ ] Verify response formats match spec

### Test Data Management
- [ ] Create test user in Cognito
- [ ] Create test accounts in DynamoDB
- [ ] Clean up test data after testing

---

## Development Workflow

### For Each Endpoint:

1. **Planning**
   - Review endpoint specification in `ENDPOINTS.md`
   - Identify dependencies and required services
   - Plan error handling scenarios

2. **Implementation**
   - Create handler file or update existing
   - Implement service layer functions
   - Add validation logic
   - Add error handling

3. **Deployment**
   - Deploy to dev environment
   ```bash
   serverless deploy --stage dev
   ```

4. **Testing**
   - Test endpoint with Postman/curl
   - Verify DynamoDB records
   - Check CloudWatch logs
   - Test error scenarios

5. **Verification**
   - Compare response with `ENDPOINTS.md` spec
   - Verify all error codes work correctly
   - Check response headers
   - Verify binary responses (for PDF)

6. **Documentation**
   - Update code comments
   - Note any deviations from spec
   - Document any issues encountered

7. **Move to Next Endpoint**
   - Mark current endpoint as complete
   - Proceed to next endpoint in order

---

## Development Checklist Summary

### Environment Setup
- [ ] Node.js 20.x installed
- [ ] Serverless Framework 3.x installed
- [ ] AWS CLI configured
- [ ] Project dependencies installed
- [ ] Directory structure created
- [ ] Configuration files created (serverless.yml, resources.yml)
- [ ] AWS resources deployed (dev environment)
- [ ] Seed data created (Plans table)
- [ ] Test user created in Cognito

### Endpoints (in order)
- [ ] `POST /accounts` - Account creation
- [ ] `GET /accounts/me` - Get account info
- [ ] `POST /generate` - PDF generation (HTML)
- [ ] `POST /generate` - PDF generation (Markdown)
- [ ] `GET /jobs` - List jobs
- [ ] `DELETE /accounts/me` - Delete account
- [ ] `GET /health` - Health check (optional)

### Testing
- [ ] Unit tests written
- [ ] Integration tests written
- [ ] Manual testing completed for all endpoints
- [ ] Error scenarios tested
- [ ] Edge cases tested

### Documentation
- [ ] Code comments added
- [ ] Any spec deviations documented
- [ ] Known issues documented

---

## Notes

- **Development Environment:** All development should be done in the `dev` stack first (`podpdf-dev`)
- **Production Deployment:** Only deploy to `prod` stack (`podpdf-prod`) after all endpoints are complete and tested in dev
- **Stack Isolation:** Dev and prod are completely separate stacks with no shared resources
- **Testing:** Each endpoint must be tested in the dev stack before moving to the next
- **Deployment:** Deploy to dev after each endpoint is complete and tested
- **Error Handling:** Follow error codes and formats from `ERRORS.md`
- **Spec Compliance:** Refer to `ENDPOINTS.md` and `SPEC.md` for exact requirements

---

**Document Version:** 1.0.0  
**Last Updated:** December 21, 2025

