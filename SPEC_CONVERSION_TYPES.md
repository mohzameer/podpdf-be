# Conversion Types Per Plan Specification

**Version:** 1.0.0  
**Date:** December 2025  
**Status:** Specification

---

## Table of Contents

1. [Overview](#overview)
2. [Conversion Types](#conversion-types)
3. [Data Model Changes](#data-model-changes)
4. [API Behavior](#api-behavior)
5. [Error Handling](#error-handling)
6. [Implementation Details](#implementation-details)
7. [Examples](#examples)

---

## Overview

This specification defines the ability to enable or disable specific conversion types (HTML, Markdown, Image) per plan. This allows for plan differentiation where:

- **Free plans** might only support basic HTML conversion
- **Paid plans** might support HTML and Markdown
- **Premium plans** might support all conversion types (HTML, Markdown, Image)

### Goals

- Allow granular control over which conversion types are available per plan
- Provide clear error messages when users attempt to use disabled conversion types
- Maintain backward compatibility (existing plans without this configuration default to allowing all types)
- Support both QuickJob and LongJob endpoints with appropriate restrictions

---

## Conversion Types

The system supports three conversion types:

1. **`html`** - HTML to PDF conversion
   - Available in: QuickJob, LongJob
   - Input: JSON body with `input_type: "html"` and `html` field

2. **`markdown`** - Markdown to PDF conversion
   - Available in: QuickJob, LongJob
   - Input: JSON body with `input_type: "markdown"` and `markdown` field

3. **`image`** - Image to PDF conversion
   - Available in: QuickJob only (not supported in LongJob)
   - Input: Multipart/form-data with `input_type: "image"` and `images` files

---

## Data Model Changes

### Plans Table

**New Field:**
- `enabled_conversion_types` (Array of Strings, optional) - List of conversion types enabled for this plan
  - Valid values: `"html"`, `"markdown"`, `"image"`
  - Default behavior: If not specified or empty array, all conversion types are enabled (backward compatible)
  - If specified, only the listed conversion types are allowed for users on this plan

**Example Plan Records:**

```json
{
  "plan_id": "free-basic",
  "name": "Free Basic",
  "type": "free",
  "monthly_quota": 100,
  "price_per_pdf": 0,
  "rate_limit_per_minute": 20,
  "enabled_conversion_types": ["html"],
  "is_active": true
}
```

```json
{
  "plan_id": "paid-standard",
  "name": "Paid Standard",
  "type": "paid",
  "price_per_pdf": 0.01,
  "enabled_conversion_types": ["html", "markdown"],
  "is_active": true
}
```

```json
{
  "plan_id": "paid-premium",
  "name": "Paid Premium",
  "type": "paid",
  "price_per_pdf": 0.01,
  "enabled_conversion_types": ["html", "markdown", "image"],
  "is_active": true
}
```

```json
{
  "plan_id": "paid-unlimited",
  "name": "Paid Unlimited",
  "type": "paid",
  "price_per_pdf": 0.01,
  "enabled_conversion_types": null,
  "is_active": true
}
```

**Notes:**
- `null` or missing field = all conversion types enabled (backward compatible)
- Empty array `[]` = all conversion types enabled (backward compatible)
- Array with specific values = only those conversion types are enabled
- Invalid values in the array should be ignored (e.g., `["html", "invalid"]` would only enable `html`)

---

## API Behavior

### Validation Flow

1. **Request arrives** at `/quickjob` or `/longjob` endpoint
2. **Authentication** is validated (JWT or API key)
3. **User and plan** are retrieved
4. **Input type** is extracted from request (`html`, `markdown`, or `image`)
5. **Conversion type check** is performed:
   - If plan has `enabled_conversion_types` field:
     - If field is `null`, missing, or empty array → allow all types (backward compatible)
     - If field is an array with values → check if requested `input_type` is in the array
     - If `input_type` is not in the array → return `403 Forbidden` error
   - If plan does not have `enabled_conversion_types` field → allow all types (backward compatible)
6. **Job type check** (for image conversion):
   - If `input_type` is `"image"` and endpoint is `/longjob` → return `400 Bad Request` (images not supported in longjob)
   - This check happens before conversion type validation
7. **Continue with existing validation** (rate limits, quota, etc.)

### Endpoint-Specific Behavior

#### POST /quickjob

- Supports all three conversion types: `html`, `markdown`, `image`
- Conversion type validation applies to all three types
- If plan disables a conversion type, requests using that type are rejected with `403 Forbidden`

#### POST /longjob

- Supports only two conversion types: `html`, `markdown`
- `image` conversion type is not supported (returns `400 Bad Request` regardless of plan)
- Conversion type validation applies to `html` and `markdown` only
- If plan disables a conversion type, requests using that type are rejected with `403 Forbidden`

---

## Error Handling

### Error: Conversion Type Not Enabled

**HTTP Status:** `403 Forbidden`

**Error Response:**
```json
{
  "error": {
    "code": "CONVERSION_TYPE_NOT_ENABLED",
    "message": "Conversion type 'markdown' is not enabled for your plan. Enabled types: html",
    "enabled_types": ["html"],
    "requested_type": "markdown"
  }
}
```

**When it occurs:**
- User's plan has `enabled_conversion_types` configured
- User requests a conversion type that is not in the enabled list
- Applies to both QuickJob and LongJob endpoints

**Error Code:** `CONVERSION_TYPE_NOT_ENABLED`

### Error: Image Not Supported in LongJob

**HTTP Status:** `400 Bad Request`

**Error Response:**
```json
{
  "error": {
    "code": "INVALID_PARAMETER",
    "message": "Image uploads (multipart/form-data) are not supported in /longjob. Use /quickjob for image-to-PDF conversion - images are fast enough to complete within the 30-second timeout.",
    "parameter": "content-type"
  }
}
```

**When it occurs:**
- User attempts to use `input_type: "image"` in `/longjob` endpoint
- This check happens before conversion type validation
- This is an existing error that remains unchanged

---

## Implementation Details

### Business Service Changes

**File:** `src/services/business.js`

**New Function:**
```javascript
/**
 * Check if conversion type is enabled for the plan
 * @param {object} plan - Plan configuration
 * @param {string} inputType - Requested input type ('html', 'markdown', 'image')
 * @returns {Promise<{allowed: boolean, error: object|null}>}
 */
async function checkConversionType(plan, inputType) {
  // If plan doesn't have enabled_conversion_types, allow all (backward compatible)
  if (!plan.enabled_conversion_types || 
      plan.enabled_conversion_types === null || 
      (Array.isArray(plan.enabled_conversion_types) && plan.enabled_conversion_types.length === 0)) {
    return { allowed: true, error: null };
  }

  // Normalize input type to lowercase
  const normalizedInputType = inputType.toLowerCase();

  // Check if input type is in enabled list
  const enabledTypes = plan.enabled_conversion_types.map(t => t.toLowerCase());
  if (enabledTypes.includes(normalizedInputType)) {
    return { allowed: true, error: null };
  }

  // Conversion type not enabled
  return {
    allowed: false,
    error: Forbidden.CONVERSION_TYPE_NOT_ENABLED(
      normalizedInputType,
      enabledTypes
    ),
  };
}
```

### Handler Changes

**Files:** `src/handlers/quickjob.js`, `src/handlers/longjob.js`

**Integration Point:**
- After user and plan are retrieved
- After input type is extracted
- Before rate limit and quota checks
- After job type validation (for image in longjob)

**Example Integration:**
```javascript
// After getting plan and extracting inputType
const conversionTypeCheck = await checkConversionType(plan, inputType);
if (!conversionTypeCheck.allowed) {
  return conversionTypeCheck.error;
}
```

### Error Utility Changes

**File:** `src/utils/errors.js`

**New Error Function:**
```javascript
CONVERSION_TYPE_NOT_ENABLED: (requestedType, enabledTypes) => ({
  statusCode: 403,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    error: {
      code: 'CONVERSION_TYPE_NOT_ENABLED',
      message: `Conversion type '${requestedType}' is not enabled for your plan. Enabled types: ${enabledTypes.join(', ')}`,
      enabled_types: enabledTypes,
      requested_type: requestedType,
    },
  }),
}),
```

### Plans Handler Changes

**File:** `src/handlers/plans.js`

**Response Update:**
- Include `enabled_conversion_types` field in plan responses
- Return `null` if field is missing (for backward compatibility)
- Return array if field exists

**Example Response:**
```json
{
  "plan": {
    "plan_id": "free-basic",
    "name": "Free Basic",
    "type": "free",
    "monthly_quota": 100,
    "price_per_pdf": 0,
    "rate_limit_per_minute": 20,
    "enabled_conversion_types": ["html"],
    "is_active": true
  }
}
```

---

## Examples

### Example 1: Free Plan with HTML Only

**Plan Configuration:**
```json
{
  "plan_id": "free-basic",
  "enabled_conversion_types": ["html"]
}
```

**Request 1: HTML Conversion (Allowed)**
```bash
POST /quickjob
{
  "input_type": "html",
  "html": "<h1>Hello</h1>"
}
```
**Result:** ✅ `200 OK` - PDF generated

**Request 2: Markdown Conversion (Blocked)**
```bash
POST /quickjob
{
  "input_type": "markdown",
  "markdown": "# Hello"
}
```
**Result:** ❌ `403 Forbidden`
```json
{
  "error": {
    "code": "CONVERSION_TYPE_NOT_ENABLED",
    "message": "Conversion type 'markdown' is not enabled for your plan. Enabled types: html",
    "enabled_types": ["html"],
    "requested_type": "markdown"
  }
}
```

**Request 3: Image Conversion (Blocked)**
```bash
POST /quickjob
Content-Type: multipart/form-data

input_type=image
images=<file1>
images=<file2>
```
**Result:** ❌ `403 Forbidden`
```json
{
  "error": {
    "code": "CONVERSION_TYPE_NOT_ENABLED",
    "message": "Conversion type 'image' is not enabled for your plan. Enabled types: html",
    "enabled_types": ["html"],
    "requested_type": "image"
  }
}
```

### Example 2: Paid Plan with HTML and Markdown

**Plan Configuration:**
```json
{
  "plan_id": "paid-standard",
  "enabled_conversion_types": ["html", "markdown"]
}
```

**Request 1: HTML Conversion (Allowed)**
```bash
POST /longjob
{
  "input_type": "html",
  "html": "<h1>Hello</h1>"
}
```
**Result:** ✅ `202 Accepted` - Job queued

**Request 2: Markdown Conversion (Allowed)**
```bash
POST /longjob
{
  "input_type": "markdown",
  "markdown": "# Hello"
}
```
**Result:** ✅ `202 Accepted` - Job queued

**Request 3: Image Conversion (Blocked)**
```bash
POST /quickjob
Content-Type: multipart/form-data

input_type=image
images=<file1>
```
**Result:** ❌ `403 Forbidden` - Conversion type not enabled

### Example 3: Premium Plan with All Types

**Plan Configuration:**
```json
{
  "plan_id": "paid-premium",
  "enabled_conversion_types": ["html", "markdown", "image"]
}
```

**All conversion types are allowed:**
- ✅ HTML in QuickJob
- ✅ HTML in LongJob
- ✅ Markdown in QuickJob
- ✅ Markdown in LongJob
- ✅ Image in QuickJob

### Example 4: Legacy Plan (No Configuration)

**Plan Configuration:**
```json
{
  "plan_id": "paid-legacy",
  "type": "paid",
  "price_per_pdf": 0.01
  // No enabled_conversion_types field
}
```

**All conversion types are allowed** (backward compatible):
- ✅ HTML in QuickJob
- ✅ HTML in LongJob
- ✅ Markdown in QuickJob
- ✅ Markdown in LongJob
- ✅ Image in QuickJob

### Example 5: Plan with Empty Array

**Plan Configuration:**
```json
{
  "plan_id": "paid-unlimited",
  "enabled_conversion_types": []
}
```

**All conversion types are allowed** (empty array = all enabled):
- ✅ HTML in QuickJob
- ✅ HTML in LongJob
- ✅ Markdown in QuickJob
- ✅ Markdown in LongJob
- ✅ Image in QuickJob

---

## Complexity Assessment

### Implementation Complexity: **Low to Medium**

**Reasoning:**
- **Low complexity** for core functionality: Simple array check in business logic
- **Medium complexity** due to integration points across multiple handlers
- **No breaking changes**: Fully backward compatible with existing plans
- **Minimal data model changes**: Single optional field added to Plans table

**Components Affected:**
1. **Business Service** (`business.js`): Add one new validation function (~30 lines)
2. **Error Utilities** (`errors.js`): Add one new error function (~15 lines)
3. **Handlers** (`quickjob.js`, `longjob.js`): Add one validation call each (~3 lines per handler)
4. **Plans Handler** (`plans.js`): Include new field in response (~1 line)
5. **Plans Table**: Add optional field (no migration needed for existing records)

**Estimated Development Time:**
- Core implementation: 2-4 hours
- Testing: 2-3 hours
- Total: 4-7 hours

---

## Migration Considerations

### Data Structure Changes

**Plans Table Changes:**
- **New Field**: `enabled_conversion_types` (Array of Strings, optional)
- **Storage Format**: DynamoDB List type (SS attribute type)
- **Existing Records**: No changes required - field is optional and defaults to "all enabled"

**Example DynamoDB Structure:**
```json
{
  "plan_id": {"S": "free-basic"},
  "name": {"S": "Free Basic"},
  "type": {"S": "free"},
  "enabled_conversion_types": {"L": [{"S": "html"}]},
  "is_active": {"BOOL": true}
}
```

**Migration Strategy (Understanding Only - Not Required):**

1. **Existing Plans (No Migration Needed):**
   - Plans without `enabled_conversion_types` field continue to work
   - System treats missing field as "all types enabled" (backward compatible)
   - No data migration script required

2. **New Plans (Optional Configuration):**
   - When creating new plans, optionally include `enabled_conversion_types`
   - Can be added via plan creation scripts or admin tools
   - Example: Update `scripts/plans-data.json` to include the field

3. **Updating Existing Plans (Optional):**
   - If desired, can update existing plans to restrict conversion types
   - Would require DynamoDB update operation per plan
   - Example update:
     ```javascript
     // Update free-basic plan to only allow HTML
     await updateItem(PLANS_TABLE, 
       { plan_id: 'free-basic' },
       'SET enabled_conversion_types = :types',
       { ':types': ['html'] }
     );
     ```

**Backward Compatibility:**
- ✅ Existing plans without the field: Work as before (all types enabled)
- ✅ Existing API clients: No changes required
- ✅ Existing job processing: No impact
- ✅ No breaking changes to any endpoints

**Rollout Strategy:**
1. Deploy code changes (backward compatible)
2. Optionally update plan configurations via scripts
3. No user-facing migration needed
4. Can be enabled/configured per plan as needed

---

## Summary

### Key Points

1. **Backward Compatible:** Plans without `enabled_conversion_types` field allow all conversion types
2. **Granular Control:** Each plan can specify exactly which conversion types are enabled
3. **Clear Errors:** Users receive clear error messages when attempting to use disabled conversion types
4. **Endpoint Awareness:** Image conversion is only available in QuickJob (existing behavior)
5. **Flexible Configuration:** `null`, missing field, or empty array all mean "all types enabled"

### Implementation Checklist

- [ ] Add `enabled_conversion_types` field to Plans table schema documentation
- [ ] Add `checkConversionType()` function to `business.js`
- [ ] Add `CONVERSION_TYPE_NOT_ENABLED` error to `errors.js`
- [ ] Integrate conversion type check in `quickjob.js` handler
- [ ] Integrate conversion type check in `longjob.js` handler
- [ ] Update `plans.js` handler to return `enabled_conversion_types` in responses
- [ ] Update plan data in `scripts/plans-data.json` (if needed)
- [ ] Add unit tests for conversion type validation
- [ ] Add integration tests for disabled conversion types

---

**End of Specification**

