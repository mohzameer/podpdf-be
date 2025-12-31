# Analysis Report: 90-Day TTL for Free Tier Job Details

## Executive Summary

This report analyzes the implementation of a 90-day Time-To-Live (TTL) for job details table entries specifically for free tier users. The analysis covers current state, implementation requirements, impacts, edge cases, and recommendations.

**Key Finding:** Implementing conditional TTL (90 days for free tier, permanent for paid tier) is technically feasible and will reduce storage costs, but requires careful handling of edge cases and existing data.

---

## 1. Current State Analysis

### 1.1 JobDetails Table Configuration

**Current Setup:**
- **Table Name:** `podpdf-{stage}-job-details`
- **Billing Mode:** PAY_PER_REQUEST
- **Partition Key:** `job_id` (UUID)
- **Global Secondary Index:** `UserIdCreatedAtIndex` on `user_id` (HASH) and `created_at` (RANGE)
- **Current TTL:** **NONE** (permanent storage as per SPEC.md line 188)

**Table Definition Location:**
- `resources.yml` lines 56-84
- No `TimeToLiveSpecification` currently configured

### 1.2 Job Creation Flow

**Job Creation Function:**
- Location: `src/services/jobTracking.js` - `createJobRecord()`
- Current implementation (lines 26-69):
  - Creates job record with: `job_id`, `user_id`, `job_type`, `mode`, `status`, `created_at`
  - Optionally includes: `webhook_url`, `api_key_id`
  - **Does NOT currently set TTL attribute**

**Job Creation Points:**
1. Quick jobs: `src/handlers/quickjob.js` - synchronous PDF generation
2. Long jobs: `src/handlers/longjob.js` - asynchronous PDF generation

**Plan Information Availability:**
- Plan information is available at job creation time via:
  - `src/services/business.js` - `validateUserAndPlan()`, `getPlan()`
  - Plan type identified by: `plan.type === 'free'` or `plan.type === 'paid'`
  - Free tier plans have `monthly_quota` set (e.g., 100 PDFs)
  - Paid tier plans have `type: 'paid'` and `price_per_pdf > 0`

### 1.3 Job Retrieval

**Endpoints:**
- `GET /jobs` - List user's jobs (via `src/handlers/jobs.js`)
- `GET /jobs/{job_id}` - Get specific job details

**Query Method:**
- Uses GSI `UserIdCreatedAtIndex` to query by `user_id`
- Ordered by `created_at` descending
- DynamoDB TTL deletion is automatic and transparent - expired items simply won't appear in queries

---

## 2. Implementation Requirements

### 2.1 Infrastructure Changes

**1. Enable TTL on JobDetails Table**
- Add `TimeToLiveSpecification` to `JobDetailsTable` in `resources.yml`
- TTL attribute name: `ttl` (standard convention)
- TTL value: Unix timestamp in seconds (not milliseconds)

**Configuration Example:**
```yaml
JobDetailsTable:
  Type: AWS::DynamoDB::Table
  Properties:
    # ... existing properties ...
    TimeToLiveSpecification:
      Enabled: true
      AttributeName: ttl
```

**2. Modify Job Creation Logic**
- Update `createJobRecord()` in `src/services/jobTracking.js`
- Accept plan information as parameter (or fetch it)
- Calculate TTL value for free tier jobs:
  - TTL = current_time_in_seconds + (90 days * 24 hours * 60 minutes * 60 seconds)
  - TTL = current_time_in_seconds + 7,776,000 seconds
- Only set `ttl` attribute for free tier jobs
- Do NOT set `ttl` attribute for paid tier jobs (permanent storage)

**3. Update Job Creation Callers**
- Modify `quickjob.js` handler to pass plan information
- Modify `longjob.js` handler to pass plan information
- Both handlers already have plan information available from `validateUserAndPlan()` or `getPlan()`

### 2.2 Code Changes Required

**Files to Modify:**
1. `resources.yml` - Add TTL specification to JobDetailsTable
2. `src/services/jobTracking.js` - Update `createJobRecord()` to accept plan and set TTL conditionally
3. `src/handlers/quickjob.js` - Pass plan to `createJobRecord()`
4. `src/handlers/longjob.js` - Pass plan to `createJobRecord()`

**No Changes Required:**
- `src/handlers/jobs.js` - Job retrieval works transparently (expired items simply won't appear)
- `src/services/jobTracking.js` - `listJobsByUserId()` and `getJobRecord()` work as-is
- API endpoints remain unchanged

---

## 3. Impact Analysis

### 3.1 Storage Cost Reduction

**Current State:**
- All job records stored permanently
- Free tier users: 100 PDFs all-time quota (per `scripts/plans-data.json`)
- Paid tier users: Unlimited PDFs

**After TTL Implementation:**
- Free tier job records: Automatically deleted after 90 days
- Paid tier job records: Permanent (no TTL set)
- **Estimated Cost Savings:** 
  - Depends on free tier user activity
  - Each job record: ~1-2 KB (estimated)
  - 100 free tier jobs = ~100-200 KB per user
  - With 1000 free tier users: ~100-200 MB total
  - After 90 days, old records auto-delete, reducing storage

**DynamoDB Storage Costs:**
- $0.25 per GB/month
- Savings scale with number of free tier users and their historical job volume

### 3.1.1 Detailed Cost Calculation: 10,000 Users × 100 Documents Each

**Scenario:** 10,000 free tier users, each creating 100 job records

**Storage Calculation:**
- Total job records: 10,000 users × 100 jobs = **1,000,000 job records**
- Average job record size: **1.5 KB** (includes all attributes: job_id, user_id, status, timestamps, metadata, etc.)
- Total storage: 1,000,000 × 1.5 KB = **1,500,000 KB = 1,500 MB = 1.5 GB**

**Cost Analysis:**

**Without TTL (Permanent Storage):**
- Storage: 1.5 GB
- Monthly cost: 1.5 GB × $0.25/GB = **$0.375/month**
- Annual cost: $0.375 × 12 = **$4.50/year**
- **Lifetime cost (10 years): $45.00** (assuming no growth)

**With 90-Day TTL:**
- **Steady State Scenario:** If users create jobs evenly over time
  - Storage stabilizes at ~90 days worth of jobs
  - Assuming users create 100 jobs over 90 days: ~1.11 jobs/day per user
  - Steady state storage: ~1.5 GB (all jobs within 90-day window)
  - Monthly cost: **$0.375/month** (same as without TTL initially)
  - **BUT:** After 90 days, old jobs expire, preventing unbounded growth

- **One-Time Creation Scenario:** All 1M jobs created at once
  - Month 1-3: Storage = 1.5 GB, cost = $0.375/month
  - Month 4+: All jobs expire, storage → ~0 GB, cost → **$0/month**
  - **Total cost over 4 months: $1.125**
  - **Savings after month 3: $0.375/month ongoing**

**Cost Savings Summary:**
- **Immediate savings:** $0 (TTL doesn't reduce storage until expiration)
- **After 90 days (one-time scenario):** $0.375/month = **$4.50/year savings**
- **After 90 days (steady state):** Prevents unbounded growth (savings increase as users create more jobs over time)
- **10-year savings (one-time scenario):** $45.00 - $1.125 = **$43.88 saved**

**Key Insight:**
- TTL provides **preventive cost control** - prevents storage from growing indefinitely
- For steady-state usage, TTL maintains storage at a constant level (90-day window)
- For one-time bulk creation, TTL provides significant savings after the 90-day period
- **Real value:** As user base grows and users create more jobs over time, TTL prevents exponential storage cost growth

### 3.2 User Experience Impact

**Positive Impacts:**
- No functional changes to API endpoints
- Users won't notice expired jobs missing (they're old anyway)
- Faster queries (fewer items to scan/query)

**Potential Concerns:**
- Free tier users lose access to job history older than 90 days
- If user upgrades to paid tier, their old free-tier jobs will still expire (created before upgrade)
- Job history dashboard will show fewer historical jobs for free tier users

**Mitigation:**
- 90 days is reasonable for free tier (most users check recent jobs)
- Paid tier users retain permanent history
- Consider documenting this limitation in API docs

### 3.3 Data Retention Considerations

**Analytics Table:**
- Separate `AnalyticsTable` exists (no TTL, permanent storage)
- Analytics data is NOT affected by JobDetails TTL
- Analytics records are anonymized (no user_id)

**Billing Records:**
- `BillsTable` is separate and permanent
- Billing history unaffected

**S3 PDF Storage:**
- PDFs in S3 have 24-hour lifecycle policy (already configured)
- Unaffected by JobDetails TTL

---

## 4. Edge Cases and Considerations

### 4.1 Existing Job Records

**Problem:**
- Existing job records in production don't have `ttl` attribute
- These will remain permanent until manually updated

**Options:**
1. **No Action:** Let existing records remain permanent (simplest)
2. **Backfill Script:** Create Lambda/script to:
   - Scan all JobDetails records
   - Identify free tier users (via `user_id` → Users table → `plan_id` → Plans table)
   - Set `ttl` for free tier jobs older than 90 days (set to past date for immediate deletion)
   - Set `ttl` for free tier jobs within 90 days (calculate proper expiration)

**Recommendation:** Option 1 (no action) for initial implementation. Existing records are historical and can remain. New records will have proper TTL.

### 4.2 Plan Upgrades

**Scenario:** User creates jobs on free tier, then upgrades to paid tier

**Current Behavior (with TTL):**
- Jobs created BEFORE upgrade: Have `ttl` set (will expire after 90 days from creation)
- Jobs created AFTER upgrade: No `ttl` set (permanent)

**Considerations:**
- Free tier jobs created before upgrade will still expire
- This may be acceptable (they were free tier jobs)
- Alternative: Update TTL on upgrade (remove `ttl` from existing free tier jobs)

**Recommendation:** Accept that pre-upgrade free tier jobs expire. This is reasonable since:
- They were created under free tier terms
- 90 days is sufficient for most use cases
- Simplifies implementation (no migration needed on upgrade)

### 4.3 Plan Downgrades

**Scenario:** User downgrades from paid to free tier (if supported)

**Current Behavior:**
- Jobs created on paid tier: No `ttl` (permanent)
- Jobs created after downgrade: `ttl` set (90 days)

**Consideration:**
- Paid tier jobs remain permanent even after downgrade
- This is acceptable (they were created under paid tier)

### 4.4 Job Status Transitions

**Scenario:** Job created on free tier, but still processing when TTL expires

**DynamoDB TTL Behavior:**
- TTL deletion happens asynchronously (within 48 hours of expiration)
- Job may still be accessible briefly after expiration
- If job is still processing, it may be deleted before completion

**Mitigation:**
- TTL is set at creation time (90 days from creation)
- Jobs typically complete within minutes/hours, not days
- Very low risk of deleting in-progress jobs

### 4.5 API Key Authentication

**Scenario:** Job created via API key (not JWT)

**Current Implementation:**
- API key authentication path also has plan information available
- `longjob.js` and `quickjob.js` handle both JWT and API key paths
- Plan lookup works the same way

**Impact:** None - plan information is available regardless of auth method

---

## 5. Implementation Complexity

### 5.1 Code Complexity: **LOW**

**Changes Required:**
1. Add TTL specification to CloudFormation template (1 line change)
2. Modify `createJobRecord()` to accept plan parameter (1 parameter)
3. Add conditional TTL calculation (5-10 lines)
4. Update 2 handler files to pass plan (1 line each)

**Total Estimated Changes:** ~20-30 lines of code

### 5.2 Testing Requirements

**Unit Tests:**
- Test `createJobRecord()` with free tier plan (should set TTL)
- Test `createJobRecord()` with paid tier plan (should NOT set TTL)
- Test TTL calculation (90 days = 7,776,000 seconds)

**Integration Tests:**
- Create job as free tier user, verify `ttl` attribute exists
- Create job as paid tier user, verify `ttl` attribute does NOT exist
- Verify job retrieval still works (expired items don't appear)

**Edge Case Tests:**
- User upgrades from free to paid (verify old jobs still have TTL)
- Job created exactly 90 days ago (verify expiration behavior)

### 5.3 Deployment Considerations

**CloudFormation Update:**
- Adding TTL specification requires table update
- **No downtime** - TTL can be enabled on existing table
- Update is non-breaking (existing items without `ttl` remain permanent)

**Rollback Plan:**
- Can disable TTL by removing `TimeToLiveSpecification`
- Existing items with `ttl` will continue to expire
- New items won't have TTL set

---

## 6. Recommendations

### 6.1 Implementation Approach

**Recommended: Phased Implementation**

**Phase 1: Infrastructure Setup**
1. Add `TimeToLiveSpecification` to `JobDetailsTable` in `resources.yml`
2. Deploy infrastructure changes
3. Verify TTL is enabled (no immediate impact)

**Phase 2: Code Implementation**
1. Update `createJobRecord()` to accept plan parameter
2. Add conditional TTL logic (free tier only)
3. Update `quickjob.js` and `longjob.js` to pass plan
4. Add unit tests
5. Deploy code changes

**Phase 3: Validation**
1. Monitor CloudWatch metrics for TTL deletions
2. Verify free tier jobs have `ttl` attribute
3. Verify paid tier jobs do NOT have `ttl` attribute
4. Test job retrieval endpoints

### 6.2 Best Practices

1. **TTL Calculation:**
   - Use Unix timestamp in seconds (not milliseconds)
   - Calculate: `Math.floor(Date.now() / 1000) + 7776000`
   - Store in `ttl` attribute as Number type

2. **Error Handling:**
   - If plan lookup fails, default to no TTL (fail-safe)
   - Log when TTL is set/not set for debugging

3. **Documentation:**
   - Update API documentation to mention 90-day retention for free tier
   - Document that paid tier has permanent job history

4. **Monitoring:**
   - Monitor DynamoDB metrics for TTL deletions
   - Track storage reduction over time
   - Alert if TTL deletion rate is unexpected

### 6.3 Alternative Considerations

**Option A: Shorter TTL (30 days)**
- Pros: More aggressive cost reduction
- Cons: Less useful for users who want to review older jobs

**Option B: Longer TTL (180 days)**
- Pros: Better user experience, more history
- Cons: Higher storage costs

**Option C: Tiered TTL**
- Free tier: 90 days
- Paid tier: 365 days (instead of permanent)
- Pros: Cost reduction for paid tier too
- Cons: More complex, may upset paid users

**Recommendation:** Stick with 90 days for free tier, permanent for paid tier (as requested)

---

## 7. Risk Assessment

### 7.1 Low Risk Items

✅ **Infrastructure Changes:** TTL can be enabled/disabled without downtime  
✅ **Code Changes:** Minimal, well-isolated changes  
✅ **Backward Compatibility:** Existing records unaffected  
✅ **API Compatibility:** No breaking changes to API  

### 7.2 Medium Risk Items

⚠️ **Data Loss:** Free tier users lose access to jobs older than 90 days  
⚠️ **User Expectations:** Users may expect permanent history (need documentation)  
⚠️ **Plan Upgrade Edge Case:** Pre-upgrade free tier jobs still expire  

### 7.3 Mitigation Strategies

1. **Documentation:** Clearly document 90-day retention policy for free tier
2. **User Communication:** Consider in-app notification about retention policy
3. **Monitoring:** Track user complaints about missing job history
4. **Flexibility:** Can adjust TTL duration if needed (90 days is configurable)

---

## 8. Cost-Benefit Analysis

### 8.1 Benefits

✅ **Storage Cost Reduction:** Automatic cleanup of old free tier job records  
✅ **Query Performance:** Fewer items to scan/query (marginal improvement)  
✅ **Compliance:** Automatic data retention management  
✅ **Scalability:** Prevents unbounded growth for free tier users  

### 8.2 Costs

❌ **Development Time:** ~2-4 hours for implementation and testing  
❌ **User Experience:** Free tier users lose access to old job history  
❌ **Complexity:** Slight increase in code complexity (conditional TTL logic)  

### 8.3 ROI

**Break-Even Analysis:**
- Implementation time: 2-4 hours
- Storage savings: Depends on free tier user volume
- For 1000 active free tier users: ~$0.10-0.20/month savings
- For 10,000 users (100 jobs each): ~$4.50/year savings
- Break-even: ~20-40 months (low ROI for small scale)

**Alternative Strategy: Marketing "All-Time History for Free"**

**Business Value Analysis:**
- **Cost of TTL implementation:** Minimal storage savings ($4.50/year for 10K users)
- **Opportunity cost of TTL:** Limiting free tier to 90-day history may reduce user satisfaction
- **Marketing value of permanent history:** "Unlimited job history, even on free tier" is a competitive differentiator
- **User acquisition impact:** Permanent history can be a selling point that drives sign-ups
- **User retention impact:** Users who can access all their historical jobs are more likely to stay

**Strategic Recommendation:**
Given the minimal cost savings ($4.50/year for 10K users), the **marketing value of "all-time job history for free"** likely outweighs the storage cost savings. This feature can be:
- A competitive differentiator in marketing materials
- A user retention tool (users value their historical data)
- A conversion driver (users see value before upgrading)

**Conclusion:** The cost savings are negligible compared to the potential marketing and retention value of offering permanent job history to free tier users. **Recommendation: DO NOT implement TTL for free tier** - instead, market "unlimited job history" as a free tier benefit.

---

## 9. Conclusion

Implementing a 90-day TTL for free tier job details is **technically feasible and low-risk**. The implementation is straightforward, requires minimal code changes, and provides automatic data cleanup.

**Key Takeaways:**
1. ✅ Low implementation complexity (~20-30 lines of code)
2. ✅ No breaking changes to API
3. ✅ Automatic cleanup reduces storage costs over time
4. ⚠️ Free tier users lose access to jobs older than 90 days
5. ⚠️ Pre-upgrade free tier jobs will still expire after upgrade

**Cost-Benefit Reality Check:**
- **Storage savings:** ~$4.50/year for 10,000 users (100 jobs each)
- **Marketing opportunity cost:** "Unlimited job history for free" is a valuable differentiator
- **User retention value:** Permanent history increases user satisfaction and stickiness

**Final Recommendation:** **DO NOT IMPLEMENT TTL for free tier**

**Rationale:**
The minimal storage cost savings ($4.50/year for 10K users) are **negligible** compared to the marketing and retention value of offering permanent job history to free tier users. Instead:

1. **Market "Unlimited Job History"** as a free tier benefit
2. **Use it as a competitive differentiator** in marketing materials
3. **Leverage it for user retention** - users value access to their historical data
4. **Consider TTL only if storage costs become significant** (e.g., 100K+ active free tier users)

The storage costs are so low that the **marketing value of permanent history far outweighs the cost savings**. Focus on user growth and retention rather than micro-optimizing minimal storage costs.

---

## 10. Implementation Checklist

- [ ] Add `TimeToLiveSpecification` to `JobDetailsTable` in `resources.yml`
- [ ] Update `createJobRecord()` to accept `plan` parameter
- [ ] Add conditional TTL calculation (free tier only)
- [ ] Update `quickjob.js` to pass plan to `createJobRecord()`
- [ ] Update `longjob.js` to pass plan to `createJobRecord()`
- [ ] Add unit tests for TTL logic
- [ ] Update API documentation with retention policy
- [ ] Deploy infrastructure changes
- [ ] Deploy code changes
- [ ] Monitor TTL deletions in CloudWatch
- [ ] Verify free tier jobs have `ttl` attribute
- [ ] Verify paid tier jobs do NOT have `ttl` attribute

---

**Report Generated:** Analysis of 90-day TTL implementation for free tier job details  
**Date:** Based on current codebase state  
**Status:** Ready for implementation review

