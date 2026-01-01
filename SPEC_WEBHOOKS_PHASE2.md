# PodPDF Multiple Webhooks Specification - Phase 2

**Version:** 1.0.0 (Phase 2)  
**Date:** December 24, 2025  
**Status:** Future Enhancements

**Note:** This document outlines Phase 2 enhancements for the Multiple Webhooks system. Phase 1 implementation is documented in `SPEC_WEBHOOKS.md`.

---

## Table of Contents

1. [Overview](#overview)
2. [Webhook Signing Secrets](#webhook-signing-secrets)
3. [Migration from Single Webhook](#migration-from-single-webhook)
4. [Advanced Retry Policies](#advanced-retry-policies)
5. [Webhook Health Monitoring](#webhook-health-monitoring)
6. [Custom Headers Support](#custom-headers-support)
7. [Additional Enhancements](#additional-enhancements)

---

## Overview

Phase 2 enhancements will add:

- **Webhook signing secrets** - HMAC-SHA256 signatures for payload verification
- **Migration from single webhook** - Automatic migration from legacy `Users.webhook_url`
- **Advanced retry policies** - Per-webhook retry configuration
- **Health monitoring** - Auto-disable unhealthy webhooks
- **Custom headers** - Support for authentication headers in webhook requests

These features build upon the Phase 1 foundation and provide enhanced security, reliability, and flexibility.

---

## Webhook Signing Secrets

### Overview

Add HMAC-SHA256 signature verification to all webhook payloads for security and authenticity.

### Data Model Updates

**Webhooks Table - New Field:**
- `signing_secret` (String) - Auto-generated webhook signing secret for HMAC-SHA256 signature verification
  - Generated automatically when webhook is created
  - Format: `whsec_<random_base64url_string>` (32+ characters)
  - Shown only once on webhook creation - user must store it securely
  - Never returned in list/update responses (security)

### Implementation

1. **Secret Generation:**
   - Generate 32-byte random secret on webhook creation
   - Encode as base64url string
   - Prefix with `whsec_` for identification
   - Store in `Webhooks` table

2. **Signature Calculation:**
   ```
   signature = HMAC-SHA256(signing_secret, JSON.stringify(payload))
   header_value = "sha256=" + hex(signature)
   ```

3. **Webhook Headers:**
   - Add `X-Webhook-Signature: sha256=<hex_signature>` to all webhook requests

4. **API Changes:**
   - `POST /accounts/me/webhooks` - Return `signing_secret` in response (only once)
   - Add warning message about storing secret securely
   - Never return secret in GET/PUT responses

### Verification Example

```javascript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signatureHeader, signingSecret) {
  const providedSignature = signatureHeader.replace('sha256=', '');
  const expectedSignature = crypto
    .createHmac('sha256', signingSecret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(providedSignature)
  );
}
```

### Trust Model

- Secret is delivered over authenticated HTTPS API session
- Only PodPDF can generate valid signatures
- Receivers verify signatures to ensure authenticity
- See Phase 1 spec for detailed trust model explanation

---

## Migration from Single Webhook

### Overview

Automatically migrate users from the legacy single webhook system (`Users.webhook_url`) to the new multiple webhooks system.

### Migration Strategy

**Option 1: Automatic Migration (Recommended)**
- When user creates first webhook via new API:
  - Check if `Users.webhook_url` exists
  - If exists, automatically create webhook record from it
  - Set `events: ["job.completed"]` (default)
  - Set `is_active: true`
  - User can then manage it via new API
  - Optionally clear `Users.webhook_url` after migration

**Option 2: Manual Migration**
- Provide migration endpoint: `POST /accounts/me/webhooks/migrate`
- User explicitly triggers migration
- Creates webhook from `Users.webhook_url`
- Returns created webhook details

### Migration Timeline

1. **Phase 2.1**: Deploy migration logic
   - Both systems work in parallel
   - New webhooks take precedence over `webhook_url`
   - Automatic migration on first webhook creation

2. **Phase 2.2**: Encourage migration
   - Add migration prompts in UI
   - Provide migration guide
   - Show migration status in account settings

3. **Phase 2.3**: Deprecate old system
   - Mark `PUT /accounts/me/webhook` as deprecated
   - Add deprecation warnings
   - Eventually remove support for `Users.webhook_url`

### Backward Compatibility

- `Users.webhook_url` field remains for backward compatibility
- Legacy endpoint `PUT /accounts/me/webhook` continues to work
- System checks new webhooks first, falls back to `webhook_url` if no webhooks exist

---

## Advanced Retry Policies

### Overview

Allow users to configure custom retry policies per webhook instead of using system defaults.

### Data Model Updates

**Webhooks Table - New Field:**
- `retry_policy` (Object, optional) - Custom retry configuration
  - `max_retries` (Number, 0-5) - Maximum retry attempts (default: 3)
  - `retry_delays` (Array of Numbers) - Retry delays in milliseconds (default: [1000, 2000, 4000])
  - If not provided, uses system defaults

### API Changes

**POST /accounts/me/webhooks - Request Body:**
```json
{
  "name": "Production Webhook",
  "url": "https://api.example.com/webhooks/podpdf",
  "events": ["job.completed"],
  "retry_policy": {
    "max_retries": 5,
    "retry_delays": [2000, 4000, 8000, 16000, 32000]
  }
}
```

**PUT /accounts/me/webhooks/{webhook_id} - Request Body:**
- Can update `retry_policy` field

### Implementation

- Use webhook's custom `retry_policy` if configured
- Fall back to system defaults if not provided
- Validate retry policy on create/update:
  - `max_retries`: 0-5
  - `retry_delays`: Array of 1-5 numbers, each >= 0

---

## Webhook Health Monitoring

### Overview

Track webhook endpoint health and automatically disable unhealthy webhooks.

### Data Model Updates

**Webhooks Table - New Fields:**
- `consecutive_failures` (Number) - Number of consecutive failures (for health monitoring)
  - Reset to 0 on successful delivery
  - Incremented on each failed delivery
- `health_status` (String) - Current health status: `"healthy"`, `"degraded"`, `"unhealthy"`
- `auto_disabled_at` (String, ISO 8601 timestamp, optional) - When webhook was auto-disabled due to health issues

### Health Status Logic

**Health Status Calculation:**
- **Healthy**: `consecutive_failures < 5` and `last_success_at` within last 24 hours
- **Degraded**: `consecutive_failures >= 5` or `last_success_at` > 24 hours ago
- **Unhealthy**: `consecutive_failures >= 10` or `last_success_at` > 7 days ago

**Auto-Disable:**
- When `consecutive_failures >= 10`:
  - Set `is_active: false`
  - Set `auto_disabled_at: <timestamp>`
  - Set `health_status: "unhealthy"`
  - Log event for monitoring

**Re-enable:**
- User can manually re-enable via `PUT /accounts/me/webhooks/{webhook_id}` with `is_active: true`
- Resets `consecutive_failures` to 0
- Clears `auto_disabled_at`

### API Changes

**GET /accounts/me/webhooks - Response:**
```json
{
  "webhooks": [
    {
      "webhook_id": "...",
      "health_status": "healthy",
      "consecutive_failures": 0,
      "auto_disabled_at": null
    }
  ]
}
```

**New Endpoint: POST /accounts/me/webhooks/{webhook_id}/re-enable**
- Re-enable auto-disabled webhook
- Reset health metrics
- Returns updated webhook

### Monitoring

- CloudWatch metrics for health status distribution
- Alerts when webhooks become unhealthy
- Dashboard showing webhook health across all users

---

## Custom Headers Support

### Overview

Allow users to configure custom HTTP headers for webhook requests (e.g., for authentication).

### Data Model Updates

**Webhooks Table - New Field:**
- `headers` (Map, optional) - Custom HTTP headers to include in webhook requests
  - Format: `{"Authorization": "Bearer token123", "X-Custom-Header": "value"}`
  - Maximum 10 headers per webhook
  - Header names must be valid HTTP header names
  - Header values: 1-1000 characters

### API Changes

**POST /accounts/me/webhooks - Request Body:**
```json
{
  "name": "Production Webhook",
  "url": "https://api.example.com/webhooks/podpdf",
  "events": ["job.completed"],
  "headers": {
    "Authorization": "Bearer token123",
    "X-Custom-Header": "value"
  }
}
```

**Validation:**
- Maximum 10 headers
- Header names: 1-100 characters, valid HTTP header format
- Header values: 1-1000 characters
- Cannot override standard headers (Content-Type, User-Agent, X-Webhook-*)

### Implementation

- Merge custom headers with standard headers
- Custom headers take precedence (except for standard headers which cannot be overridden)
- Store headers securely (encrypted at rest if needed)

### Security Notes

- Headers are stored in plaintext in DynamoDB
- Never returned in list responses (security)
- Only returned in GET single webhook response (authenticated user only)
- Users should use URL-based authentication when possible (more secure)

---

## Additional Enhancements

### Webhook Test Endpoint

**POST /accounts/me/webhooks/{webhook_id}/test**

Send a test webhook to verify configuration:
- Uses mock payload
- Records in WebhookHistory
- Returns delivery status

### Webhook Statistics Endpoint

**GET /accounts/me/webhooks/{webhook_id}/stats**

Enhanced statistics:
- Success rate percentage
- Average delivery time
- Failure rate by error type
- Event distribution
- Time-series data (last 30 days)

### Webhook Bulk Operations

**POST /accounts/me/webhooks/bulk-update**

Update multiple webhooks at once:
- Enable/disable multiple webhooks
- Update events for multiple webhooks
- Useful for maintenance

### Webhook Templates

Pre-configured webhook templates:
- Common event combinations
- Pre-filled headers for popular services
- Quick setup for common use cases

### Webhook Replay

**POST /accounts/me/webhooks/{webhook_id}/replay/{delivery_id}**

Replay a failed webhook delivery:
- Useful for debugging
- Re-sends exact payload
- Creates new delivery record

---

## Implementation Priority

**High Priority:**
1. Webhook signing secrets (security)
2. Migration from single webhook (user experience)

**Medium Priority:**
3. Advanced retry policies (flexibility)
4. Health monitoring (reliability)

**Low Priority:**
5. Custom headers support (convenience)
6. Additional enhancements (nice-to-have)

---

## Summary

Phase 2 will add:

✅ **Webhook signing secrets** - HMAC-SHA256 signatures for security  
✅ **Migration from single webhook** - Automatic migration from legacy system  
✅ **Advanced retry policies** - Per-webhook retry configuration  
✅ **Health monitoring** - Auto-disable unhealthy webhooks  
✅ **Custom headers** - Support for authentication headers  
✅ **Additional features** - Test endpoint, statistics, bulk operations

These enhancements will provide enterprise-grade security, reliability, and flexibility while maintaining backward compatibility with Phase 1.

---

**Document Version:** 1.0.0 (Phase 2)  
**Last Updated:** December 24, 2025  
**Status:** Future Enhancements

