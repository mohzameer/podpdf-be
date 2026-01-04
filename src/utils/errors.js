/**
 * Error response formatting utility
 * Formats errors according to the API specification
 */

/**
 * Create a standardized error response
 * @param {number} statusCode - HTTP status code
 * @param {string} code - Error code (e.g., 'ACCOUNT_NOT_FOUND')
 * @param {string} message - Human-readable error message
 * @param {object} details - Additional error details
 * @returns {object} Formatted error response
 */
function createErrorResponse(statusCode, code, message, details = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      error: {
        code,
        message,
        details,
      },
    }),
  };
}

/**
 * Bad Request (400) errors
 */
const BadRequest = {
  INVALID_INPUT_TYPE: (provided, allowed = ['html', 'markdown', 'image']) =>
    createErrorResponse(
      400,
      'INVALID_INPUT_TYPE',
      `input_type must be one of: ${allowed.map(a => `'${a}'`).join(', ')}`,
      { provided, allowed }
    ),

  MISSING_INPUT_TYPE: () =>
    createErrorResponse(400, 'MISSING_INPUT_TYPE', 'input_type field is required', {
      required: 'input_type',
    }),

  MISSING_CONTENT_FIELD: (inputType) =>
    createErrorResponse(
      400,
      'MISSING_CONTENT_FIELD',
      `${inputType} field is required when input_type is '${inputType}'`,
      { input_type: inputType, missing_field: inputType }
    ),

  EMPTY_CONTENT_FIELD: (inputType) =>
    createErrorResponse(
      400,
      'EMPTY_CONTENT_FIELD',
      `${inputType} field cannot be empty`,
      { input_type: inputType, field: inputType }
    ),

  CONFLICTING_FIELDS: (inputType) =>
    createErrorResponse(
      400,
      'CONFLICTING_FIELDS',
      'Both html and markdown fields cannot be provided. Provide only the field matching your input_type.',
      {
        input_type: inputType,
        conflict: inputType === 'html' ? 'markdown field should not be present when input_type is \'html\'' : 'html field should not be present when input_type is \'markdown\'',
      }
    ),

  WRONG_FIELD_PROVIDED: (inputType, invalidField) =>
    createErrorResponse(
      400,
      'WRONG_FIELD_PROVIDED',
      `${invalidField} field should not be present when input_type is '${inputType}'`,
      { input_type: inputType, invalid_field: invalidField }
    ),

  CONTENT_TYPE_MISMATCH: (inputType, detectedType) =>
    createErrorResponse(
      400,
      'CONTENT_TYPE_MISMATCH',
      `Content appears to be ${detectedType.toUpperCase()} but input_type is '${inputType}'`,
      {
        input_type: inputType,
        detected_type: detectedType,
        reason: 'Content starts with HTML tags',
      }
    ),

  INPUT_SIZE_EXCEEDED: (maxSize) =>
    createErrorResponse(
      400,
      'INPUT_SIZE_EXCEEDED',
      `Input size exceeds the maximum limit of ${maxSize}MB`,
      { max_size_mb: maxSize }
    ),

  INVALID_PLAN_ID: (planId, reason = null) =>
    createErrorResponse(
      400,
      'INVALID_PLAN_ID',
      reason || `Invalid plan_id: ${planId}`,
      {
      provided: planId,
        reason: reason || 'Plan not found or invalid',
      }
    ),

  INVALID_PARAMETER: (paramName, message) =>
    createErrorResponse(
      400,
      'INVALID_PARAMETER',
      `Invalid ${paramName}: ${message}`,
      {
        parameter: paramName,
        message,
      }
    ),

  PAGE_LIMIT_EXCEEDED: (pageCount, maxPages) =>
    createErrorResponse(
      400,
      'PAGE_LIMIT_EXCEEDED',
      `PDF page count (${pageCount}) exceeds maximum allowed pages (${maxPages})`,
      {
        page_count: pageCount,
        max_pages: maxPages,
      }
    ),

  INVALID_WEBHOOK_URL: () =>
    createErrorResponse(
      400,
      'INVALID_WEBHOOK_URL',
      'webhook_url must be a valid HTTPS URL',
      { action_required: 'provide_valid_https_url' }
    ),

  // Image-specific errors
  INVALID_IMAGE_FORMAT: (details = {}) =>
    createErrorResponse(
      400,
      'INVALID_IMAGE_FORMAT',
      details.message || 'Image format not supported. Only PNG and JPEG are allowed.',
      details
    ),

  INVALID_IMAGE_DATA: (details = {}) =>
    createErrorResponse(
      400,
      'INVALID_IMAGE_DATA',
      details.message || 'Image data is corrupted or invalid.',
      details
    ),

  IMAGE_TOO_LARGE: (details = {}) =>
    createErrorResponse(
      400,
      'IMAGE_TOO_LARGE',
      details.message || 'Image exceeds size or dimension limits.',
      details
    ),

  MISSING_IMAGES: () =>
    createErrorResponse(
      400,
      'MISSING_IMAGES',
      'No image files provided in multipart request.',
      { action_required: 'provide_image_files' }
    ),

  INVALID_MULTIPART: (message = 'Malformed multipart/form-data request') =>
    createErrorResponse(
      400,
      'INVALID_MULTIPART',
      message,
      { action_required: 'send_valid_multipart_request' }
    ),

  INVALID_OPTIONS_JSON: (message = 'Options field is not valid JSON') =>
    createErrorResponse(
      400,
      'INVALID_OPTIONS_JSON',
      message,
      { action_required: 'provide_valid_json_options' }
    ),
};

/**
 * Unauthorized (401) errors
 */
const Unauthorized = {
  MISSING_TOKEN: () =>
    createErrorResponse(401, 'UNAUTHORIZED', 'Missing or invalid JWT token', {
      action_required: 'provide_valid_jwt_token',
    }),

  INVALID_TOKEN: () =>
    createErrorResponse(401, 'UNAUTHORIZED', 'Invalid or expired JWT token', {
      action_required: 'obtain_new_token',
    }),
};

/**
 * Forbidden (403) errors
 */
const Forbidden = {
  ACCOUNT_NOT_FOUND: () =>
    createErrorResponse(
      403,
      'ACCOUNT_NOT_FOUND',
      'User account not found. Please create an account before using the API.',
      { action_required: 'create_account' }
    ),

  RATE_LIMIT_EXCEEDED: (limit, window, retryAfter) =>
    createErrorResponse(
      403,
      'RATE_LIMIT_EXCEEDED',
      'Rate limit exceeded',
      {
        limit,
        window,
        retry_after: retryAfter,
        type: 'per_user_rate_limit',
      }
    ),

  QUOTA_EXCEEDED: (currentUsage, quota, quotaExceeded = true) =>
    createErrorResponse(
      403,
      'QUOTA_EXCEEDED',
      'All-time quota of 100 PDFs has been reached. Please upgrade to a paid plan to continue using the service.',
      {
        current_usage: currentUsage,
        quota,
        quota_exceeded: quotaExceeded,
        action_required: 'upgrade_to_paid_plan',
      }
    ),

  CONVERSION_TYPE_NOT_ENABLED: (requestedType, enabledTypes) =>
    createErrorResponse(
      403,
      'CONVERSION_TYPE_NOT_ENABLED',
      `Conversion type '${requestedType}' is not enabled for your plan. Enabled types: ${enabledTypes.join(', ')}`,
      {
        enabled_types: enabledTypes,
        requested_type: requestedType,
      }
    ),

  INSUFFICIENT_CREDITS: (currentBalance, requiredAmount) =>
    createErrorResponse(
      403,
      'INSUFFICIENT_CREDITS',
      'Insufficient credits to generate PDF. Please purchase credits to continue.',
      {
        current_balance: currentBalance,
        required_amount: requiredAmount,
        action_required: 'purchase_credits',
      }
    ),

  ACCOUNT_ALREADY_EXISTS: () =>
    createErrorResponse(
      409,
      'ACCOUNT_ALREADY_EXISTS',
      'Account already exists for this user',
      { action_required: 'use_existing_account' }
    ),

  WEBHOOK_LIMIT_EXCEEDED: (planId, planType, currentCount, maxAllowed) =>
    createErrorResponse(
      403,
      'WEBHOOK_LIMIT_EXCEEDED',
      'Webhook limit exceeded for your plan',
      {
        plan_id: planId,
        plan_type: planType,
        current_count: currentCount,
        max_allowed: maxAllowed,
        upgrade_required: true,
      }
    ),

  WEBHOOK_NOT_FOUND: () =>
    createErrorResponse(
      404,
      'WEBHOOK_NOT_FOUND',
      'Webhook not found',
      { action_required: 'check_webhook_id' }
    ),

  WEBHOOK_ACCESS_DENIED: () =>
    createErrorResponse(
      403,
      'WEBHOOK_ACCESS_DENIED',
      'Webhook does not belong to authenticated user',
      { action_required: 'use_correct_webhook_id' }
    ),

  ACCESS_DENIED: (message = 'Access denied') =>
    createErrorResponse(
      403,
      'ACCESS_DENIED',
      message,
      { action_required: 'check_resource_ownership' }
    ),
};

/**
 * Not Found (404) errors
 */
const NotFound = {
  NOT_FOUND: (message = 'Resource not found') =>
    createErrorResponse(
      404,
      'NOT_FOUND',
      message,
      { action_required: 'check_resource_id' }
    ),
};

/**
 * Request Timeout (408) errors
 */
const RequestTimeout = {
  QUICKJOB_TIMEOUT: (jobId, timeoutSeconds) =>
    createErrorResponse(
      408,
      'QUICKJOB_TIMEOUT',
      'Job processing exceeded 30-second timeout. Please use /longjob endpoint for larger documents.',
      {
        job_id: jobId,
        timeout_seconds: timeoutSeconds,
        suggestion: 'use_longjob_endpoint',
      }
    ),
};

/**
 * Internal Server Error (500)
 */
const InternalServerError = {
  GENERIC: (message = 'An unexpected error occurred') =>
    createErrorResponse(
      500,
      'INTERNAL_SERVER_ERROR',
      message,
      { action_required: 'retry_later' }
    ),

  PDF_GENERATION_FAILED: (errorMessage) =>
    createErrorResponse(
      500,
      'PDF_GENERATION_FAILED',
      'Failed to generate PDF',
      { error: errorMessage }
    ),
};

module.exports = {
  createErrorResponse,
  BadRequest,
  Unauthorized,
  Forbidden,
  NotFound,
  RequestTimeout,
  InternalServerError,
};

