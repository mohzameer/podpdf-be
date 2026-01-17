# Sentry Integration Spec - Production Only

## Overview
Integrate Sentry error monitoring **only for production**, with zero overhead in development. Sentry code should not execute at all in dev environments.

## Goals
- ✅ **Dev**: No Sentry code runs, no DSN, no wrapping, no overhead
- ✅ **Prod**: Errors automatically reported to Sentry
- ✅ **Zero noise**: No accidental error capture in dev

---

## Implementation Plan

### Step 1: Install Sentry Package
**File**: `package.json`

Add dependency:
```json
"@sentry/aws-serverless": "^2.x.x"
```

**Action**: Add to `dependencies` section

---

### Step 2: Serverless Configuration
**File**: `serverless.yml`

#### 2.1 Add SENTRY_DSN to prod stage environment
**Location**: `custom.stages.prod` section (around line 438)

Add:
```yaml
custom:
  stages:
    prod:
      environment:
        SENTRY_DSN: ${ssm:/podpdf/prod/sentry/dsn}
      # ... existing prod config
```

**Note**: Do NOT add SENTRY_DSN to dev stage or global provider environment.

#### 2.2 Merge environment variables into functions
**Location**: Each function definition in `functions:` section

For each function that should be monitored, add:
```yaml
functions:
  quickjob:
    handler: src/handlers/quickjob.handler
    environment: ${self:custom.stages.${self:provider.stage}.environment, {}}
    # ... rest of config
```

**Functions to update** (all handlers):
- `quickjob`
- `longjob`
- `longjob-processor`
- `credit-deduction-processor`
- `jobs`
- `plans`
- `api-keys`
- `webhook-manager`
- `accounts`
- `api-key-authorizer`
- `health`
- `signup`
- `confirm-signup`
- `signin`
- `refresh`
- `cognito-post-confirmation`
- `paddle-webhook`

**Note**: Functions that already have `environment:` sections need to merge with the stage environment.

#### 2.3 Update IAM permissions for SSM
**Location**: `provider.iam.role.statements` (around line 144-150)

Add Sentry DSN SSM parameter to existing SSM permissions:
```yaml
- arn:aws:ssm:${self:provider.region}:*:parameter/podpdf/${self:provider.stage}/sentry/dsn
```

---

### Step 3: Create Sentry Wrapper Utility
**File**: `src/utils/sentry.js` (NEW FILE)

Create a conditional Sentry wrapper that:
- Only initializes Sentry in prod when SENTRY_DSN is present
- Returns a no-op wrapper function in dev
- Uses lazy require to avoid loading Sentry SDK in dev

```javascript
/**
 * Sentry wrapper utility
 * Only initializes Sentry in production when SENTRY_DSN is available
 * Returns no-op wrapper in dev to ensure zero overhead
 */

let wrap = (handler) => handler;

const isProd = process.env.STAGE === 'prod' && !!process.env.SENTRY_DSN;

if (isProd) {
  const Sentry = require('@sentry/aws-serverless');
  
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: 'prod',
    tracesSampleRate: 0, // Disable performance monitoring
    integrations: [],
    beforeBreadcrumb: () => null, // Disable breadcrumbs
  });
  
  wrap = Sentry.wrapHandler;
}

/**
 * Wraps a Lambda handler with Sentry (only in prod)
 * In dev, returns the handler unchanged
 * 
 * @param {Function} handler - Lambda handler function
 * @returns {Function} Wrapped handler (or original in dev)
 */
function wrapHandler(handler) {
  return wrap(handler);
}

module.exports = { wrapHandler };
```

---

### Step 4: Update All Handler Files
**Pattern**: Update each handler to use the Sentry wrapper

**Current pattern** (all handlers):
```javascript
async function handler(event) {
  // handler logic
}

module.exports = { handler };
```

**New pattern**:
```javascript
const { wrapHandler } = require('../utils/sentry');

async function handler(event) {
  // handler logic (unchanged)
}

module.exports = { handler: wrapHandler(handler) };
```

**Files to update** (18 handlers):
1. `src/handlers/quickjob.js`
2. `src/handlers/longjob.js`
3. `src/handlers/longjob-processor.js`
4. `src/handlers/credit-deduction-processor.js`
5. `src/handlers/jobs.js`
6. `src/handlers/plans.js`
7. `src/handlers/api-keys.js`
8. `src/handlers/webhook-manager.js`
9. `src/handlers/accounts.js`
10. `src/handlers/api-key-authorizer.js`
11. `src/handlers/health.js`
12. `src/handlers/signup.js`
13. `src/handlers/confirm-signup.js`
14. `src/handlers/signin.js`
15. `src/handlers/refresh.js`
16. `src/handlers/cognito-post-confirmation.js`
17. `src/handlers/paddle-webhook.js`
18. `src/handlers/generate.js` (if still in use)

---

## Implementation Checklist

### Prerequisites
- [ ] Sentry DSN stored in AWS SSM Parameter Store at `/podpdf/prod/sentry/dsn`
- [ ] AWS credentials have permission to read SSM parameter

### Code Changes
- [ ] Install `@sentry/aws-serverless` package
- [ ] Create `src/utils/sentry.js` utility
- [ ] Update `serverless.yml`:
  - [ ] Add `SENTRY_DSN` to `custom.stages.prod.environment`
  - [ ] Add `environment` merge to all function definitions
  - [ ] Add SSM permission for Sentry DSN parameter
- [ ] Update all 18 handler files to use `wrapHandler`

### Testing
- [ ] Verify dev deployment: No Sentry code executes (check logs)
- [ ] Verify prod deployment: Sentry initializes correctly
- [ ] Test error reporting in prod: Trigger an error and verify it appears in Sentry

---

## Environment Variable Behavior

### Development (`stage: dev`)
- `SENTRY_DSN`: **undefined** (not set)
- `STAGE`: `"dev"`
- Result: Sentry wrapper returns handler unchanged, no SDK loaded

### Production (`stage: prod`)
- `SENTRY_DSN`: Retrieved from SSM `/podpdf/prod/sentry/dsn`
- `STAGE`: `"prod"`
- Result: Sentry initializes and wraps all handlers

---

## Configuration Details

### Sentry Init Options
- `dsn`: From environment variable (only in prod)
- `environment`: Hardcoded to `"prod"`
- `tracesSampleRate`: `0` (disable performance monitoring)
- `integrations`: `[]` (minimal integrations)
- `beforeBreadcrumb`: `null` (disable breadcrumbs for zero noise)

### Why This Approach?
1. **Lazy require**: `require('@sentry/aws-serverless')` only executes in prod
2. **Conditional init**: Sentry.init() only called when both STAGE=prod AND SENTRY_DSN exists
3. **No-op wrapper**: In dev, `wrap` is just `(handler) => handler`, zero overhead
4. **Zero side effects**: No SDK code path in dev means no accidental initialization

---

## Rollout Strategy

1. **Phase 1**: Install package and create utility (no behavior change)
2. **Phase 2**: Update serverless.yml config (dev still works, prod gets DSN)
3. **Phase 3**: Update handlers one by one or in batches
4. **Phase 4**: Deploy to dev first, verify no Sentry code runs
5. **Phase 5**: Deploy to prod, verify Sentry captures errors

---

## Notes

- The `generate.js` handler may be deprecated based on codebase structure. Include it if still in use, otherwise skip.
- All handlers follow the same pattern, making updates straightforward.
- The wrapper pattern ensures handler logic remains unchanged - only the export changes.
- SSM parameter must be created manually in AWS before prod deployment.
