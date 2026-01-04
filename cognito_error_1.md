# Cognito PostConfirmation AccessDenied – Incident Summary

## Overview

This document describes a production issue encountered with **Amazon Cognito PostConfirmation triggers**, its root cause, and the steps taken to resolve it. The purpose of this document is to preserve institutional knowledge and prevent recurrence after future stack changes or redeployments.

---

## Symptoms

* User signup **email confirmation succeeded** in Cognito
* Cognito users appeared in **CONFIRMED** state
* The **PostConfirmation Lambda was not executed**
* No CloudWatch logs were generated for the PostConfirmation Lambda
* The API returned an error similar to:

```
AccessDeniedException
UnexpectedLambdaException
```

This resulted in partial signup completion:

* Authentication succeeded
* Account provisioning logic (e.g. DynamoDB user creation) did not run

---

## Root Cause

The Lambda function had a **resource-based invoke permission** that was scoped to an **old Cognito User Pool ARN**.

### What caused this

1. The Serverless stack (or Cognito User Pool) was deleted and recreated
2. Cognito generated a **new User Pool ID and ARN**
3. The PostConfirmation Lambda permission still referenced the **old User Pool ARN**
4. Cognito attempted to invoke the Lambda from the **new User Pool ARN**
5. IAM correctly denied the invocation due to a `SourceArn` mismatch

Even though a permission existed, it did **not match the invoking pool**, so Cognito was denied.

---

## Evidence

### Current User Pool ARN

```
arn:aws:cognito-idp:eu-central-1:ACCOUNT_ID:userpool/eu-central-1_DYtybOJbi
```

### Stale Lambda Permission

```json
"Condition": {
  "ArnLike": {
    "AWS:SourceArn": "arn:aws:cognito-idp:eu-central-1:ACCOUNT_ID:userpool/eu-central-1_IfLfrXjQI"
  }
}
```

Because these ARNs did not match **exactly**, Cognito invocation failed.

---

## Why This Was Hard to Detect

* Cognito **does not roll back** user confirmation when PostConfirmation fails
* The Lambda **never starts**, so **no CloudWatch logs** are generated
* The Lambda console still shows a valid-looking permission
* The error is surfaced as a generic `UnexpectedLambdaException`

This is a classic **stale infrastructure permission** issue after stack recreation.

---

## Resolution

### Fix Applied

1. Removed the PostConfirmation trigger from the Cognito User Pool
2. Saved the trigger configuration
3. Re-added the same Lambda **from the AWS Console dropdown** (not by pasting ARN)
4. Cognito automatically regenerated the Lambda invoke permission using the **current User Pool ARN**

After this, the Lambda policy contained:

* One old (stale) permission – harmless
* One new permission matching the current User Pool ARN

---

## Verification

### Command used

```bash
aws lambda get-policy \
  --function-name podpdf-prod-cognito-post-confirmation
```

Verified that the policy contained:

```
AWS:SourceArn = arn:aws:cognito-idp:eu-central-1:ACCOUNT_ID:userpool/eu-central-1_DYtybOJbi
```

Confirmed that:

* PostConfirmation Lambda executed
* CloudWatch logs appeared
* Account provisioning logic completed successfully

---

## Key Learnings / Best Practices

* Lambda invoke permissions are **conditional** — `SourceArn` must match exactly
* Recreating a Cognito User Pool **always changes its ARN**
* After any stack recreation:

  * Re-verify Cognito trigger permissions
  * Or reattach triggers to refresh permissions
* Absence of CloudWatch logs usually means **pre-invocation IAM denial**
* API Gateway and custom domains are **not involved** in Cognito trigger execution

---

## Diagnostic Commands

```bash
# Get current user pool ARN
aws cognito-idp describe-user-pool \
  --user-pool-id <POOL_ID> \
  --query "UserPool.Arn"

# Get Lambda invoke policy
aws lambda get-policy \
  --function-name <POST_CONFIRMATION_LAMBDA>
```

If these ARNs do not match exactly, invocation will fail.

---

## Final Status

* Cognito PostConfirmation trigger correctly wired
* Lambda invoke permissions aligned with current User Pool
* Signup and account creation flow fully operational

---
