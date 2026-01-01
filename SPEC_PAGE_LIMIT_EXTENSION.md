# Page Limit Extension Specification

**Version:** 1.0.0  
**Date:** December 2025  
**Status:** Specification  
**Purpose:** Extend maximum page limitation beyond 100 pages for LongJob endpoint

---

## Table of Contents

1. [Overview](#overview)
2. [Current Architecture & Limitations](#current-architecture--limitations)
3. [Challenges with Extending Beyond 100 Pages](#challenges-with-extending-beyond-100-pages)
4. [Proposed Rearchitecture Options](#proposed-rearchitecture-options)
5. [Recommended Approach](#recommended-approach)
6. [Implementation Details](#implementation-details)
7. [Migration Strategy](#migration-strategy)
8. [Cost Implications](#cost-implications)
9. [Testing & Validation](#testing--validation)
10. [Rollout Plan](#rollout-plan)

---

## Overview

### Current State

- **Maximum Page Limit:** 100 pages (enforced via `MAX_LONGJOB_PAGES` environment variable)
- **Enforcement:** Hard limit - requests exceeding 100 pages are rejected with `400 PAGE_LIMIT_EXCEEDED` error
- **Job Type:** LongJob only (QuickJob has separate 25-page limit)
- **Architecture:** Single Lambda function processes entire PDF in one execution
- **Current Constraints:** Lambda 3008 MB memory, 15-minute timeout

### Key Questions Answered

**Q1: Can current LongJob architecture support 300 pages of heavy HTML?**

**Answer:** **Partially, with risks:**
- **Simple HTML (text-heavy):** ✅ Yes, can support up to ~300 pages
- **Heavy HTML (complex layouts, images, CSS):** ⚠️ **Marginal** - 200-300 pages is the practical limit
  - Memory: Heavy HTML uses 2-3x more memory (~150-300 MB per 100 pages)
  - Time: Heavy HTML takes 2-3x longer (~5-8 minutes for 300 pages)
  - **Risk:** May approach Lambda timeout (15 min) or memory limits (3008 MB)
- **Very Heavy HTML:** ❌ May struggle with 200+ pages

**Q2: Should we use EC2/ECS and create a separate endpoint for pages > 300?**

**Answer:** **Yes, recommended approach:**
- **Phase 1:** Extend `/longjob` to 200-300 pages (Lambda-based, remove pre-validation)
- **Phase 2:** Create `/verylongjob` endpoint using ECS/Fargate for 300+ pages
- **Rationale:**
  - Lambda is cost-effective for 200-300 pages
  - ECS/Fargate provides unlimited memory/time for 300+ pages
  - Clear separation: Lambda for medium jobs, ECS for large jobs
  - Better reliability for very large documents

### Goal

Extend the maximum page limit for LongJob to support larger documents while maintaining:
- Reliability and error handling
- Cost efficiency
- Performance characteristics
- Backward compatibility

**Recommended Strategy:**
- **Lambda-based `/longjob`:** 100-300 pages (depending on HTML complexity)
- **ECS-based `/verylongjob`:** 300+ pages (unlimited memory/time)

### Scope

This specification covers:
- ✅ LongJob endpoint only (QuickJob remains at 25 pages)
- ✅ HTML and Markdown conversion types (Image conversion not supported in LongJob)
- ✅ Asynchronous processing architecture
- ✅ SQS queue-based job processing
- ✅ S3 storage and webhook notifications

---

## Current Architecture & Limitations

### Current Flow

```
1. Client → POST /longjob
2. Handler validates request, checks rate limits/quota
3. Handler pre-validates by generating PDF (to check page count) ← INEFFICIENT
4. If valid, job queued to SQS
5. Processor picks up job from SQS
6. Processor generates PDF again ← DUPLICATE WORK
7. Processor uploads PDF to S3
8. Processor calls webhook
```

### Current Concurrency Architecture

**How the system handles 10,000 concurrent users:**

1. **Handler (`longjob` Lambda):**
   - Receives HTTP requests via API Gateway
   - **Auto-scales:** Each request triggers a separate Lambda invocation
   - **Concurrency:** API Gateway can handle 10,000+ concurrent requests
   - **Processing:** Handler only queues to SQS (fast, ~1-2 seconds)
   - **No bottleneck:** Handler doesn't generate PDFs, just queues jobs

2. **SQS Queue:**
   - **Unlimited capacity:** Can hold millions of messages
   - **Buffering:** Acts as a buffer between requests and processing
   - **Reliability:** Messages persist until processed
   - **Visibility timeout:** 900 seconds (15 minutes) - message hidden while processing

3. **Processor (`longjob-processor` Lambda):**
   - **SQS-triggered:** Automatically invoked when messages arrive
   - **Batch size:** `batchSize: 1` (one job per Lambda invocation)
   - **Auto-scaling:** AWS automatically scales Lambda concurrency based on queue depth
   - **Concurrent executions:** Multiple Lambda instances process jobs in parallel
   - **Default limit:** 1,000 concurrent executions per region (can request increase)
   - **Scaling behavior:**
     - Queue depth = 10 → ~10 concurrent Lambdas
     - Queue depth = 100 → ~100 concurrent Lambdas
     - Queue depth = 1,000 → ~1,000 concurrent Lambdas (up to limit)

**Example: 10,000 concurrent users submitting jobs:**

```
Time 0:00 - 10,000 users submit jobs
  ↓
Handler (longjob): 10,000 Lambda invocations (auto-scales)
  ↓ Each queues to SQS in ~1-2 seconds
  ↓
SQS Queue: 10,000 messages queued
  ↓
Processor (longjob-processor): AWS auto-scales to process queue
  ↓
  - First 1,000 messages → 1,000 concurrent Lambda executions
  - Each Lambda processes one 100-page PDF (~30-60 seconds)
  - As Lambdas complete, new ones start for remaining messages
  - Continues until all 10,000 jobs processed
```

**Key Points:**
- ✅ **Handler scales instantly:** No bottleneck, just queues jobs
- ✅ **SQS buffers everything:** Unlimited message capacity
- ✅ **Processor auto-scales:** AWS handles concurrency automatically
- ✅ **No manual configuration needed:** Serverless auto-scaling
- ✅ **Cost-effective:** Pay only for actual processing time

**Concurrency Limits:**
- **Default Lambda concurrency:** 1,000 per region (can request increase to 10,000+)
- **SQS throughput:** Unlimited (can handle millions of messages)
- **API Gateway:** 10,000+ concurrent connections
- **DynamoDB:** Auto-scales (on-demand billing mode)

**For 10,000+ concurrent users:**
- May need to request Lambda concurrency limit increase from AWS
- Or: Use multiple regions (each region has separate concurrency limit)
- Or: Use ECS/Fargate for `/verylongjob` (no concurrency limits)

### Impact of Extending Page Limits on Concurrency

**Current (100 pages):**
- Processing time: ~30-60 seconds per job
- With 1,000 concurrent Lambda limit: Can process ~1,000-2,000 jobs per minute
- **10,000 jobs:** Processed in ~5-10 minutes (with 1,000 concurrent executions)

**Extended to 300 pages (heavy HTML):**
- Processing time: ~5-8 minutes per job (3x longer)
- With 1,000 concurrent Lambda limit: Can process ~125-200 jobs per minute
- **10,000 jobs:** Processed in ~50-80 minutes (10x longer)

**Key Insight:**
- Longer processing times = fewer jobs processed per minute
- But: SQS queue buffers everything, so jobs are still queued instantly
- Users get immediate response (202 Accepted), processing happens asynchronously
- **No impact on user experience** - they're not waiting for completion

**Solutions for Higher Throughput:**
1. **Request Lambda concurrency increase:** AWS can increase to 10,000+ per region
2. **Use ECS/Fargate:** No concurrency limits, can scale to thousands of tasks
3. **Multiple regions:** Distribute load across regions (each has separate limit)
4. **Optimize processing:** Remove pre-validation reduces processing time by 50%

**Recommendation:**
- For 200-300 pages: Lambda is sufficient (may need concurrency limit increase)
- For 300+ pages: Consider ECS/Fargate for better scalability and no limits

### Current Constraints

#### 1. Lambda Memory Limits
- **Current:** 3008 MB (maximum available)
- **Issue:** Large PDFs (500+ pages) may require more memory for:
  - Chromium/Puppeteer browser instance
  - HTML rendering in memory
  - PDF buffer generation
  - **Risk:** Out-of-memory errors for very large documents

#### 2. Lambda Timeout Limits
- **Current:** 900 seconds (15 minutes) maximum
- **Issue:** Very large PDFs may take longer than 15 minutes to:
  - Render HTML content
  - Generate PDF pages
  - Upload to S3
  - **Risk:** Timeout errors, incomplete PDFs

#### 3. Double PDF Generation
- **Current:** Handler generates PDF for validation, processor generates again
- **Issue:** 
  - Wastes compute resources
  - Doubles processing time
  - Increases costs
  - For large PDFs, this becomes prohibitively expensive

#### 4. PDF Buffer Size
- **Current:** Entire PDF held in memory as Buffer
- **Issue:** 
  - 100-page PDF ≈ 5-10 MB
  - 1000-page PDF ≈ 50-100 MB
  - Memory usage scales linearly with page count
  - **Risk:** Memory exhaustion for very large PDFs

#### 5. S3 Upload Constraints
- **Current:** Single `PutObject` call with entire PDF buffer
- **Issue:** 
  - Large buffers may hit Lambda memory limits
  - No streaming support
  - **Risk:** Upload failures for very large PDFs

### Current Configuration

```yaml
# serverless.yml
longjob-processor:
  memorySize: 3008  # Maximum available
  timeout: 900      # Maximum available (15 minutes)
```

```javascript
// Current page limit enforcement
const MAX_LONGJOB_PAGES = parseInt(process.env.MAX_LONGJOB_PAGES || '100', 10);

// Handler pre-validation (inefficient)
pdfResult = await generatePDF(content, inputType, options || {}, MAX_LONGJOB_PAGES);

// Processor generation (duplicate)
pdfResult = await generatePDF(content, input_type, options || {}, MAX_LONGJOB_PAGES);
```

---

## Challenges with Extending Beyond 100 Pages

### 1. Memory Constraints

**Problem:** Chromium + Puppeteer + PDF generation requires significant memory:
- Base Chromium: ~200-300 MB
- **Simple HTML rendering:** ~50-100 MB per 100 pages
- **Heavy HTML rendering** (complex CSS, images, layouts): ~150-300 MB per 100 pages
- PDF buffer: ~5-10 MB per 100 pages
- **Estimated for 300 pages (heavy HTML):** ~1.0-1.5 GB
- **Estimated for 1000 pages (heavy HTML):** ~3-4 GB (exceeds Lambda limit)

**Current Memory:** 3008 MB
- **Simple HTML:** Sufficient for ~500-800 pages
- **Heavy HTML:** Practical limit ~200-300 pages (safety margin needed)
- **Very Heavy HTML:** May struggle with 200+ pages

**Solution Options:**
- Increase Lambda memory (already at max)
- Use streaming/chunked PDF generation
- Use ECS/Fargate for larger memory allocation
- Split PDF generation into multiple Lambda invocations

### 2. Timeout Constraints

**Problem:** Large PDFs take longer to generate:
- **Simple HTML:**
  - 100 pages: ~30-60 seconds
  - 300 pages: ~2-3 minutes
  - 500 pages: ~3-5 minutes
- **Heavy HTML** (complex layouts, images, CSS):
  - 100 pages: ~1-2 minutes
  - 300 pages: ~5-8 minutes
  - 500 pages: ~10-15 minutes (approaching timeout)
- **Risk:** Heavy HTML with 300+ pages may approach 15-minute Lambda timeout

**Solution Options:**
- Remove pre-validation (eliminates duplicate generation)
- Optimize PDF generation (parallel rendering, streaming)
- Use Step Functions for multi-step processing
- Use ECS/Fargate for longer execution times

### 3. Cost Implications

**Current Cost per 100-page PDF:**
- Handler pre-validation: ~30-60 seconds @ 1024 MB = ~$0.0001
- Processor generation: ~30-60 seconds @ 3008 MB = ~$0.0003
- **Total:** ~$0.0004 per PDF

**Projected Cost per 1000-page PDF (if no changes):**
- Handler pre-validation: ~8-12 minutes @ 1024 MB = ~$0.001
- Processor generation: ~8-12 minutes @ 3008 MB = ~$0.003
- **Total:** ~$0.004 per PDF (10x increase)

**Solution:** Remove pre-validation to cut costs in half

### 4. Reliability Concerns

**Problem:** Single Lambda execution for entire PDF:
- If Lambda fails mid-generation, entire job fails
- No checkpoint/resume capability
- No partial progress tracking
- **Risk:** Lost work, user frustration

**Solution Options:**
- Implement checkpointing (save progress to S3/DynamoDB)
- Use Step Functions for state management
- Split into multiple smaller jobs (not ideal for single document)

---

## Proposed Rearchitecture Options

### Option 1: Remove Pre-Validation (Minimal Change)

**Approach:** Remove PDF generation from handler, only validate in processor

**Changes:**
- Remove pre-validation PDF generation from `longjob.js` handler
- Keep all validation in processor
- Accept that page limit errors occur after queuing (acceptable for async jobs)

**Pros:**
- ✅ Eliminates duplicate PDF generation
- ✅ Reduces costs by ~50%
- ✅ Minimal code changes
- ✅ No infrastructure changes
- ✅ Faster handler response time

**Cons:**
- ❌ Page limit errors occur after queuing (user waits longer for error)
- ❌ Still subject to Lambda memory/timeout limits
- ❌ No solution for 1000+ page documents

**Best For:** Extending to 200-300 pages (simple HTML) or 100-200 pages (heavy HTML)

---

### Option 2: Streaming PDF Generation (Moderate Change)

**Approach:** Generate PDF in chunks, stream to S3, merge chunks

**Changes:**
- Modify `pdf.js` to support chunked generation
- Stream PDF chunks directly to S3 (multipart upload)
- Use PDF-lib to merge chunks if needed
- Or use Puppeteer's streaming capabilities

**Pros:**
- ✅ Reduces memory usage (don't hold entire PDF in memory)
- ✅ Supports larger PDFs (1000+ pages)
- ✅ More efficient S3 uploads
- ✅ Better error recovery (partial uploads)

**Cons:**
- ❌ Complex implementation (Puppeteer doesn't natively support streaming)
- ❌ May require PDF merging logic
- ❌ Still subject to Lambda timeout limits
- ❌ Requires significant code changes

**Best For:** 500-1000 pages

---

### Option 3: Step Functions Orchestration (Significant Change)

**Approach:** Use AWS Step Functions to orchestrate multi-step PDF generation

**Flow:**
```
1. Handler queues job → Step Function execution
2. Step 1: Validate content, estimate pages
3. Step 2: Generate PDF in chunks (multiple Lambda invocations)
4. Step 3: Merge chunks (if needed)
5. Step 4: Upload to S3
6. Step 5: Call webhook
```

**Pros:**
- ✅ Bypasses Lambda timeout limits (Step Functions can run for hours)
- ✅ Supports checkpointing and retries
- ✅ Can split work across multiple Lambda invocations
- ✅ Better error handling and recovery
- ✅ Progress tracking capability

**Cons:**
- ❌ Significant infrastructure changes
- ❌ More complex architecture
- ❌ Higher costs (Step Functions pricing)
- ❌ Requires rearchitecting job tracking
- ❌ Longer implementation time

**Best For:** 1000+ pages, enterprise use cases

---

### Option 4: ECS/Fargate Processing with Separate Endpoint (Major Change)

**Approach:** Create separate endpoint for very large jobs, use ECS/Fargate containers

**Changes:**
- Create new `/verylongjob` endpoint
- Route jobs > 300 pages to ECS/Fargate instead of Lambda
- Configure ECS with higher memory (e.g., 4-8 GB)
- Configure longer timeouts (no 15-minute limit)
- Use SQS to trigger ECS tasks
- Keep `/longjob` for 100-300 pages (Lambda-based)

**Pros:**
- ✅ No memory limits (can allocate 4-8 GB+)
- ✅ No timeout limits (can run for hours)
- ✅ More control over resources
- ✅ Better for very large PDFs (300-2000+ pages)
- ✅ Clear separation of concerns (Lambda for medium, ECS for large)
- ✅ Can scale ECS independently

**Cons:**
- ❌ Major infrastructure change
- ❌ Higher costs (ECS always running vs. Lambda pay-per-use)
- ❌ More complex deployment
- ❌ Requires container orchestration
- ❌ Two codebases to maintain (Lambda + ECS)

**Best For:** Documents with 300+ pages, especially heavy HTML with complex layouts

---

### Option 5: Hybrid Approach with Separate Endpoint (Recommended)

**Approach:** Combine Option 1 (remove pre-validation) with separate endpoint for large jobs

**Strategy:**
- **Phase 1:** Remove pre-validation, extend `/longjob` to 200-300 pages (Lambda)
- **Phase 2:** Create `/verylongjob` endpoint using ECS/Fargate for 300+ pages
- Implement configurable page limits per plan
- Route based on estimated page count or plan tier

**Pros:**
- ✅ Immediate improvement (remove duplicate work)
- ✅ Supports most use cases (200-300 pages with Lambda)
- ✅ Clear separation: Lambda for medium, ECS for large
- ✅ Plan-based differentiation
- ✅ Future-proof (can scale ECS independently)
- ✅ Lower risk (keep Lambda for most jobs)

**Cons:**
- ❌ Requires maintaining two processing paths
- ❌ More complex routing logic
- ❌ ECS costs higher than Lambda (but only for large jobs)

**Best For:** Phased rollout, supporting both medium (200-300 pages) and large (300+ pages) documents

---

## Recommended Approach

### Phase 1: Immediate Improvements (Option 1 + Plan-Based Limits)

**Goal:** Extend to 200-300 pages with minimal changes (Lambda-based)

**Reality Check:**
- **Simple HTML:** Can support up to ~300 pages with current Lambda (3008 MB, 15 min timeout)
- **Heavy HTML:** Practical limit ~200-300 pages (complex layouts, images, CSS consume more memory/time)
- **Very Heavy HTML:** May struggle with 200+ pages, risk of timeout/memory issues

**Changes:**

1. **Remove Pre-Validation**
   - Remove PDF generation from `longjob.js` handler
   - Move page limit validation to processor only
   - Accept that errors occur after queuing (acceptable for async)

2. **Plan-Based Page Limits**
   - Add `max_pages` field to Plans table
   - Default: 100 pages (backward compatible)
   - Standard plans: 200-300 pages (Lambda-based)
   - Premium plans: 300+ pages (requires `/verylongjob` endpoint)

3. **Optimize Memory Usage**
   - Processor memory already at 3008 MB (max)
   - Optimize Puppeteer options (disable unnecessary features)
   - Add memory monitoring and alerts
   - Monitor for heavy HTML that may exceed limits

4. **Error Handling**
   - Improve error messages for page limit exceeded
   - Include plan limit in error response
   - Suggest `/verylongjob` endpoint for 300+ pages
   - Suggest plan upgrade if limit exceeded

**Implementation Time:** 1-2 days  
**Risk:** Low  
**Cost Impact:** -50% (eliminates duplicate generation)  
**Practical Limit:** 200-300 pages (depending on HTML complexity)

---

### Phase 2: Very Long Job Endpoint (ECS/Fargate)

**Goal:** Support 300+ pages for premium plans using dedicated infrastructure

**Changes:**

1. **Create `/verylongjob` Endpoint**
   - New endpoint specifically for 300+ page documents
   - Route jobs based on estimated page count or plan tier
   - Use ECS/Fargate for processing (4-8 GB memory, no timeout limit)
   - Same API interface as `/longjob` (transparent to user)

2. **ECS/Fargate Setup**
   - Containerized PDF generation service
   - Higher memory allocation (4-8 GB)
   - Longer execution times (no 15-minute limit)
   - SQS-triggered ECS tasks
   - Auto-scaling based on queue depth

3. **Routing Logic**
   - Plans with `max_pages >= 300` → route to `/verylongjob`
   - Plans with `max_pages < 300` → route to `/longjob` (Lambda)
   - Or: Estimate page count from content size, route accordingly

4. **Progress Tracking**
   - Add progress updates to job status
   - Webhook notifications for progress milestones
   - Better user experience for long-running jobs

**Implementation Time:** 2-3 weeks  
**Risk:** Medium  
**Cost Impact:** Higher per-job cost (ECS), but only for large jobs

---

## Implementation Details

### Phase 1: Remove Pre-Validation

#### 1.1 Handler Changes (`src/handlers/longjob.js`)

**Current Code:**
```javascript
// Pre-validate page limit by generating PDF and checking page count
let pdfResult;
try {
  pdfResult = await generatePDF(content, inputType, options || {}, MAX_LONGJOB_PAGES);
} catch (error) {
  if (error.message && error.message.startsWith('PAGE_LIMIT_EXCEEDED:')) {
    // Return error
  }
}
```

**New Code:**
```javascript
// Remove pre-validation - validate in processor only
// This eliminates duplicate PDF generation and reduces costs
// For async jobs, it's acceptable for errors to occur after queuing

// Optional: Basic content size validation (not page count)
const contentSize = Buffer.byteLength(content, 'utf8');
const maxContentSize = 5 * 1024 * 1024; // 5 MB
if (contentSize > maxContentSize) {
  return BadRequest.INPUT_SIZE_EXCEEDED(contentSize, maxContentSize);
}
```

**Benefits:**
- Eliminates duplicate PDF generation
- Faster handler response time
- Reduces costs by ~50%
- Still validates input size (prevents abuse)

---

#### 1.2 Plan Configuration

**Add to Plans Table Schema:**
```json
{
  "plan_id": "free-basic",
  "max_pages": 100,  // New field
  // ... other fields
}

{
  "plan_id": "paid-standard",
  "max_pages": 200,  // New field
  // ... other fields
}

{
  "plan_id": "paid-premium",
  "max_pages": 500,  // New field
  // ... other fields
}

{
  "plan_id": "paid-enterprise",
  "max_pages": 1000,  // New field
  // ... other fields
}
```

**Default Behavior:**
- If `max_pages` not specified: Default to 100 (backward compatible)
- If `max_pages` is `null`: Default to 100 (backward compatible)

---

#### 1.3 Processor Changes (`src/handlers/longjob-processor.js`)

**Current Code:**
```javascript
const MAX_LONGJOB_PAGES = parseInt(process.env.MAX_LONGJOB_PAGES || process.env.MAX_PAGES || '100', 10);

// Generate PDF
pdfResult = await generatePDF(content, input_type, options || {}, MAX_LONGJOB_PAGES);
```

**New Code:**
```javascript
// Get user and plan to determine page limit
const user = await getUserAccount(userSub);
let plan = null;
if (user) {
  const planId = user.plan_id || 'free-basic';
  plan = await getPlan(planId);
}

// Determine page limit from plan or environment variable
const planMaxPages = plan?.max_pages || null;
const envMaxPages = parseInt(process.env.MAX_LONGJOB_PAGES || process.env.MAX_PAGES || '100', 10);
const effectiveMaxPages = planMaxPages !== null ? planMaxPages : envMaxPages;

// Generate PDF with plan-specific limit
pdfResult = await generatePDF(content, input_type, options || {}, effectiveMaxPages);
```

**Error Handling:**
```javascript
catch (error) {
  if (error.message && error.message.startsWith('PAGE_LIMIT_EXCEEDED:')) {
    const [, pageCount, maxPages] = error.message.split(':');
    
    // Update job record with detailed error
    await updateJobRecord(jobId, {
      status: 'failed',
      error_message: `PDF page count (${pageCount}) exceeds maximum allowed pages (${maxPages}) for your plan. Current plan: ${plan?.plan_id || 'unknown'}, Plan limit: ${planMaxPages || envMaxPages} pages.`,
      error_code: 'PAGE_LIMIT_EXCEEDED',
      page_count: parseInt(pageCount, 10),
      max_pages: parseInt(maxPages, 10),
      plan_id: plan?.plan_id || null,
    });

    // Deliver webhook with upgrade suggestion
    if (webhook_url) {
      await deliverWebhook(webhook_url, {
        job_id: jobId,
        status: 'failed',
        error_code: 'PAGE_LIMIT_EXCEEDED',
        error_message: `PDF page count (${pageCount}) exceeds maximum allowed pages (${maxPages}) for your plan.`,
        page_count: parseInt(pageCount, 10),
        max_pages: parseInt(maxPages, 10),
        plan_id: plan?.plan_id || null,
        upgrade_suggestion: planMaxPages ? `Consider upgrading to a plan with higher page limits.` : null,
        created_at: job.created_at,
        failed_at: new Date().toISOString(),
      });
    }
    
    return;
  }
  throw error;
}
```

---

#### 1.4 Business Service Changes (`src/services/business.js`)

**New Function:**
```javascript
/**
 * Get maximum page limit for a plan
 * @param {object} plan - Plan configuration
 * @returns {number} Maximum pages allowed
 */
function getPlanMaxPages(plan) {
  if (!plan) {
    return parseInt(process.env.MAX_LONGJOB_PAGES || process.env.MAX_PAGES || '100', 10);
  }
  
  // If plan has max_pages configured, use it
  if (plan.max_pages !== null && plan.max_pages !== undefined) {
    return parseInt(plan.max_pages, 10);
  }
  
  // Otherwise, use environment variable default
  return parseInt(process.env.MAX_LONGJOB_PAGES || process.env.MAX_PAGES || '100', 10);
}
```

---

#### 1.5 Plans Handler Changes (`src/handlers/plans.js`)

**Update Response:**
```javascript
// Include max_pages in plan response
const planResponse = {
  plan_id: plan.plan_id,
  name: plan.name,
  type: plan.type,
  monthly_quota: plan.monthly_quota,
  price_per_pdf: plan.price_per_pdf,
  rate_limit_per_minute: plan.rate_limit_per_minute,
  max_pages: plan.max_pages || 100,  // Include max_pages, default to 100
  enabled_conversion_types: plan.enabled_conversion_types || null,
  is_active: plan.is_active,
};
```

---

### Phase 2: Very Long Job Endpoint (ECS/Fargate)

**Note:** ECS/Fargate implementation is out of scope for Phase 1. This section outlines the approach for Phase 2.

**Architecture:**
```
Client → POST /verylongjob
  ↓
Handler (Lambda) → Validate & Queue to SQS (verylongjob-queue)
  ↓
ECS Task (Fargate) → Process Job
  ↓
Generate PDF (4-8 GB memory, no timeout)
  ↓
Upload to S3
  ↓
Update Job Record
  ↓
Call Webhook
```

**Implementation Details:**

1. **New Endpoint: `/verylongjob`**
   - Same API interface as `/longjob`
   - Routes to ECS/Fargate processing
   - Plan-based routing: Plans with `max_pages >= 300` → `/verylongjob`
   - Or: Content-based routing: Estimate page count, route if > 300

2. **ECS/Fargate Service:**
   - Containerized PDF generation (same code as Lambda processor)
   - Memory: 4-8 GB (configurable per plan)
   - CPU: 2-4 vCPU
   - Timeout: No limit (or 1-2 hours max)
   - Auto-scaling: Based on SQS queue depth

3. **SQS Queue:**
   - Separate queue: `verylongjob-queue`
   - Same message format as `longjob-queue`
   - Dead-letter queue for failed jobs

4. **Job Tracking:**
   - Same `JobDetails` table
   - Add `processing_type` field: `"lambda"` or `"ecs"`
   - Same webhook and status tracking

**Cost Comparison:**
- **Lambda (300 pages, heavy HTML):** ~$0.0015 per PDF (15 min @ 3008 MB)
- **ECS (300 pages, heavy HTML):** ~$0.002-0.003 per PDF (15 min @ 4 GB, but ECS always running)
- **ECS (1000 pages, heavy HTML):** ~$0.005-0.008 per PDF (30-45 min @ 4 GB)

**Note:** ECS costs more per job but provides unlimited scalability and reliability for very large documents.

---

## Migration Strategy

### Backward Compatibility

**Critical:** All changes must be backward compatible.

1. **Plans Table:**
   - Existing plans without `max_pages` field → Default to 100 pages
   - No migration needed for existing plans
   - New plans can specify `max_pages`

2. **Environment Variables:**
   - `MAX_LONGJOB_PAGES` still works as fallback
   - Plan `max_pages` takes precedence if specified

3. **API Behavior:**
   - No breaking changes to API responses
   - Error messages enhanced but backward compatible
   - Webhook payloads enhanced but backward compatible

---

### Rollout Plan

#### Step 1: Deploy Handler Changes (Remove Pre-Validation)
- **Risk:** Low (only removes validation, doesn't change core logic)
- **Testing:** Verify handler no longer generates PDFs
- **Rollback:** Revert handler code if issues

#### Step 2: Deploy Processor Changes (Plan-Based Limits)
- **Risk:** Low (adds plan lookup, doesn't change core logic)
- **Testing:** Verify plan limits are respected
- **Rollback:** Revert processor code if issues

#### Step 3: Update Plans Table
- **Risk:** Low (adds optional field, defaults work)
- **Testing:** Verify existing plans default to 100 pages
- **Rollback:** Remove `max_pages` field if issues

#### Step 4: Update Plans Data
- **Risk:** Low (data-only change)
- **Testing:** Verify new plans have correct `max_pages`
- **Rollback:** Revert plan data if issues

---

## Cost Implications

### Current Costs (100-page PDF)

**Handler (Pre-Validation):**
- Duration: ~30-60 seconds
- Memory: 1024 MB
- Cost: ~$0.0001 per PDF

**Processor:**
- Duration: ~30-60 seconds
- Memory: 3008 MB
- Cost: ~$0.0003 per PDF

**Total:** ~$0.0004 per PDF

---

### Phase 1 Costs (After Removing Pre-Validation)

**Handler:**
- Duration: ~1-2 seconds (no PDF generation)
- Memory: 1024 MB
- Cost: ~$0.000003 per PDF (99% reduction)

**Processor (100-page PDF):**
- Duration: ~30-60 seconds
- Memory: 3008 MB
- Cost: ~$0.0003 per PDF

**Total:** ~$0.0003 per PDF (**25% cost reduction**)

---

### Phase 1 Costs (500-page PDF)

**Handler:**
- Duration: ~1-2 seconds
- Memory: 1024 MB
- Cost: ~$0.000003 per PDF

**Processor:**
- Duration: ~3-5 minutes
- Memory: 3008 MB
- Cost: ~$0.0015 per PDF

**Total:** ~$0.0015 per PDF (**3.75x increase vs. 100 pages, but acceptable**)

---

### Cost Optimization Recommendations

1. **Monitor Memory Usage:**
   - Add CloudWatch metrics for memory utilization
   - Optimize Puppeteer options to reduce memory
   - Consider reducing memory allocation if not needed

2. **Monitor Duration:**
   - Add CloudWatch metrics for processing duration
   - Alert if approaching timeout limits
   - Optimize PDF generation if possible

3. **Plan-Based Pricing:**
   - Consider charging more for higher page limits
   - Premium plans with 500+ pages should have higher `price_per_pdf`

---

## Testing & Validation

### Unit Tests

**Test Cases:**
1. Handler no longer generates PDFs (removed pre-validation)
2. Processor respects plan `max_pages` limit
3. Processor falls back to environment variable if plan has no `max_pages`
4. Error messages include plan information
5. Webhook payloads include plan information

**Files to Test:**
- `src/handlers/longjob.js`
- `src/handlers/longjob-processor.js`
- `src/services/business.js`
- `src/handlers/plans.js`

---

### Integration Tests

**Test Scenarios:**

1. **Free Plan (100 pages default):**
   - Request with 50 pages → ✅ Success
   - Request with 100 pages → ✅ Success
   - Request with 101 pages → ❌ Error with plan limit

2. **Premium Plan (500 pages):**
   - Request with 400 pages → ✅ Success
   - Request with 500 pages → ✅ Success
   - Request with 501 pages → ❌ Error with plan limit

3. **Plan Without max_pages (backward compatibility):**
   - Request with 100 pages → ✅ Success (uses env var)
   - Request with 101 pages → ❌ Error (uses env var)

4. **Error Handling:**
   - Verify error messages include plan information
   - Verify webhook payloads include plan information
   - Verify job status includes error details

---

### Load Tests

**Test Scenarios:**
1. **100-page PDF:** Verify processing time and memory usage
2. **500-page PDF:** Verify processing time and memory usage
3. **Concurrent Jobs:** Verify system handles multiple large PDFs
4. **Memory Monitoring:** Verify no out-of-memory errors

---

## Rollout Plan

### Phase 1: Immediate Improvements

**Timeline:** 1-2 days

**Steps:**
1. ✅ Remove pre-validation from handler
2. ✅ Add plan-based page limit support
3. ✅ Update processor to use plan limits
4. ✅ Update plans handler to return `max_pages`
5. ✅ Add unit tests
6. ✅ Deploy to dev environment
7. ✅ Integration testing in dev
8. ✅ Deploy to prod environment
9. ✅ Monitor for issues

**Success Criteria:**
- Handler no longer generates PDFs
- Processor respects plan limits
- Error messages are clear and helpful
- No increase in error rates
- Cost reduction confirmed

---

### Phase 2: Advanced Features (Future)

**Timeline:** 1-2 weeks (if needed)

**Steps:**
1. Design Step Functions state machine
2. Implement chunked PDF generation
3. Implement progress tracking
4. Update job tracking for Step Functions
5. Add premium plan with 1000+ page support
6. Testing and validation
7. Rollout to premium customers

**Success Criteria:**
- Step Functions successfully processes 1000+ page PDFs
- Progress tracking works correctly
- Webhook notifications include progress updates
- No increase in error rates

---

## Summary

### Key Changes

1. **Remove Pre-Validation:** Eliminates duplicate PDF generation, reduces costs by 50%
2. **Plan-Based Limits:** Allows different page limits per plan (100, 200, 300+)
3. **Improved Error Handling:** Better error messages with plan information
4. **Backward Compatible:** Existing plans default to 100 pages
5. **Separate Endpoint for Large Jobs:** `/verylongjob` using ECS/Fargate for 300+ pages

### Realistic Capabilities

**Lambda-Based `/longjob` (Phase 1):**
- **Simple HTML:** Up to ~300 pages ✅
- **Heavy HTML:** Up to ~200-300 pages ⚠️ (practical limit, may approach timeout)
- **Very Heavy HTML:** Up to ~200 pages ⚠️ (may struggle)

**ECS-Based `/verylongjob` (Phase 2):**
- **All HTML Types:** 300+ pages ✅ (unlimited memory/time)
- **Recommended for:** Complex layouts, large images, enterprise documents

### Benefits

- ✅ **Cost Reduction:** 50% reduction by eliminating duplicate generation
- ✅ **Flexibility:** Plan-based limits allow tiered pricing
- ✅ **Scalability:** Lambda for medium (200-300 pages), ECS for large (300+ pages)
- ✅ **Reliability:** ECS provides better reliability for very large documents
- ✅ **Future-Proof:** Can scale ECS independently for enterprise customers

### Risks

- ⚠️ **Page Limit Errors After Queuing:** Errors occur in processor, not handler (acceptable for async)
- ⚠️ **Memory Constraints:** Heavy HTML with 300+ pages may exceed Lambda limits
- ⚠️ **Timeout Risk:** Heavy HTML with 300+ pages may approach 15-minute timeout
- ⚠️ **Two Codebases:** Need to maintain Lambda and ECS processing paths

### Mitigation

- Monitor memory usage and processing duration
- Alert if approaching limits
- Route 300+ page jobs to `/verylongjob` (ECS) automatically
- Optimize Puppeteer options to reduce memory usage
- Consider content complexity estimation for routing decisions

---

## Implementation Checklist

### Phase 1: Immediate Improvements

- [ ] Remove pre-validation PDF generation from `longjob.js` handler
- [ ] Add `max_pages` field to Plans table schema documentation
- [ ] Update processor to use plan-based page limits
- [ ] Add `getPlanMaxPages()` function to `business.js`
- [ ] Update plans handler to return `max_pages` in responses
- [ ] Update error handling to include plan information
- [ ] Update webhook payloads to include plan information
- [ ] Add unit tests for plan-based limits
- [ ] Add integration tests for different plan limits
- [ ] Update plans data with `max_pages` values
- [ ] Deploy to dev environment
- [ ] Integration testing in dev
- [ ] Deploy to prod environment
- [ ] Monitor for issues

### Phase 2: Advanced Features (Future)

- [ ] Design Step Functions state machine
- [ ] Implement chunked PDF generation
- [ ] Implement progress tracking
- [ ] Update job tracking for Step Functions
- [ ] Add premium plan with 1000+ page support
- [ ] Testing and validation
- [ ] Rollout to premium customers

---

**End of Specification**

