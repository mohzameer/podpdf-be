# Schema Changes: ULID-based user_id

## Summary

The Users table has been updated to use ULID-based `user_id` as the primary key instead of `user_sub`, while keeping `user_sub` for Cognito authentication lookups.

---

## Changes Made

### 1. Users Table Structure

**Before:**
- Partition Key: `user_sub` (Cognito identifier)

**After:**
- Partition Key: `user_id` (ULID - e.g., `"01ARZ3NDEKTSV4RRFFQ69G5FAV"`)
- Global Secondary Index: `UserSubIndex` on `user_sub` (for lookups by Cognito user_sub)

### 2. New Fields Added

- `user_id` (String, ULID) - Primary identifier
- `email` (String) - User's email address (from Cognito)
- `display_name` (String, optional) - User's display name

### 3. Fields Retained

- `user_sub` (String) - Cognito user identifier (for authentication lookups)
- `plan_id` (String)
- `account_status` (String)
- `total_pdf_count` (Number)
- `created_at` (String, ISO 8601)
- `upgraded_at` (String, ISO 8601, optional)

---

## Implementation Details

### ULID Library

Added `ulid` package to `package.json`:
```json
"ulid": "^2.3.0"
```

### ULID Utility

Created `src/utils/ulid.js`:
```javascript
const { generateULID } = require('../utils/ulid');
const userId = generateULID(); // e.g., "01ARZ3NDEKTSV4RRFFQ69G5FAV"
```

### DynamoDB Lookups

**By user_id (primary key):**
```javascript
const user = await getItem(USERS_TABLE, { user_id: userId });
```

**By user_sub (GSI lookup):**
```javascript
const result = await query(
  USERS_TABLE,
  'user_sub = :user_sub',
  { ':user_sub': userSub },
  'UserSubIndex'
);
const user = result.Items[0];
```

---

## Updated Files

1. **resources.yml** - Updated Users table schema with ULID primary key and GSI
2. **SPEC.md** - Updated Users table documentation
3. **ENDPOINTS.md** - Updated response examples to include `user_id`, `email`, `display_name`
4. **package.json** - Added `ulid` dependency
5. **src/utils/ulid.js** - New ULID utility module
6. **src/services/dynamodb.js** - Enhanced query function to support pagination

---

## Migration Notes

### For New Deployments

No migration needed - the new schema will be created automatically.

### For Existing Deployments

If you have an existing Users table with `user_sub` as the primary key:

1. **Option 1: Fresh Start (Recommended for Dev)**
   - Delete existing Users table
   - Redeploy with new schema

2. **Option 2: Data Migration**
   - Export existing user data
   - Generate ULIDs for each user
   - Import with new schema
   - Update related tables (JobDetails, UserRateLimits) to reference `user_id` if needed

---

## Usage in Code

### Creating a User

```javascript
const { generateULID } = require('../utils/ulid');
const { putItem } = require('../services/dynamodb');

const user = {
  user_id: generateULID(),
  user_sub: cognitoUserSub,
  email: cognitoEmail,
  display_name: cognitoDisplayName || null,
  plan_id: 'free-basic',
  account_status: 'free',
  total_pdf_count: 0,
  created_at: new Date().toISOString(),
};

await putItem(USERS_TABLE, user);
```

### Looking Up User by Cognito user_sub

```javascript
const { query } = require('../services/dynamodb');

const result = await query(
  process.env.USERS_TABLE,
  'user_sub = :user_sub',
  { ':user_sub': userSub },
  'UserSubIndex'
);

if (result.Items.length === 0) {
  // User not found
  return null;
}

const user = result.Items[0];
```

### Looking Up User by user_id

```javascript
const { getItem } = require('../services/dynamodb');

const user = await getItem(process.env.USERS_TABLE, { user_id: userId });
```

---

## Benefits of ULID

1. **Sortable:** ULIDs are lexicographically sortable by creation time
2. **URL-safe:** No special characters, safe for URLs and filenames
3. **Shorter than UUID:** 26 characters vs 36 for UUID
4. **Time-ordered:** Can extract timestamp from ULID
5. **Better for distributed systems:** No central coordination needed

---

## Related Tables

### UserRateLimits Table

**Current structure:**
- Partition Key: `user_sub` (kept for fast JWT-based lookups)
- Sort Key: `minute_timestamp`
- Optional attribute: `user_id` (can be stored for consistency)

**Why keep `user_sub` as partition key:**
- Rate limiting happens immediately after JWT validation
- We extract `user_sub` directly from JWT token
- No need to look up Users table first - direct access is faster
- `user_id` can be stored as an attribute if needed for consistency

### JobDetails Table

**Current structure:**
- Partition Key: `job_id` (UUID)
- GSI: `UserSubCreatedAtIndex` on `user_sub`
- Field: `user_sub` (for querying user's jobs)

**Consideration:** We could add `user_id` as an attribute and create a GSI on `user_id` for future use, but `user_sub` lookups are still needed since that's what we get from JWT.

---

## Next Steps

When implementing endpoints:
1. Extract `user_sub` from JWT token (via API Gateway authorizer)
2. Look up user by `user_sub` using `UserSubIndex` GSI
3. Use `user_id` for all internal references and responses
4. Store `user_id` in related tables (JobDetails, etc.) for consistency

