/**
 * Validation Service
 * Handles request body validation and input size checks
 */

const { BadRequest } = require('../utils/errors');
const logger = require('../utils/logger');

const MAX_INPUT_SIZE_MB = parseInt(process.env.MAX_INPUT_SIZE_MB || '5', 10);
const MAX_INPUT_SIZE_BYTES = MAX_INPUT_SIZE_MB * 1024 * 1024;

/**
 * Validate request body structure
 * @param {object} body - Request body
 * @returns {object} Validation result with isValid, error, and parsed data
 */
function validateRequestBody(body) {
  // Check if body exists
  if (!body || typeof body !== 'object') {
    return {
      isValid: false,
      error: BadRequest.MISSING_INPUT_TYPE(),
      data: null,
    };
  }

  // Check input_type field
  if (!body.input_type) {
    return {
      isValid: false,
      error: BadRequest.MISSING_INPUT_TYPE(),
      data: null,
    };
  }

  const inputType = body.input_type.toLowerCase();

  // Validate input_type value
  if (inputType !== 'html' && inputType !== 'markdown' && inputType !== 'image') {
    return {
      isValid: false,
      error: BadRequest.INVALID_INPUT_TYPE(inputType, ['html', 'markdown', 'image']),
      data: null,
    };
  }

  // Image input type is handled separately via multipart
  // If we get here with input_type: 'image' in JSON body, it's an error
  if (inputType === 'image') {
    return {
      isValid: false,
      error: BadRequest.INVALID_PARAMETER('input_type', 'Image uploads must use multipart/form-data, not JSON'),
      data: null,
    };
  }

  // Check content field based on input_type
  const contentField = inputType;
  const content = body[contentField];

  if (!content) {
    return {
      isValid: false,
      error: BadRequest.MISSING_CONTENT_FIELD(contentField),
      data: null,
    };
  }

  if (typeof content !== 'string') {
    return {
      isValid: false,
      error: BadRequest.MISSING_CONTENT_FIELD(contentField),
      data: null,
    };
  }

  if (content.trim().length === 0) {
    return {
      isValid: false,
      error: BadRequest.EMPTY_CONTENT_FIELD(contentField),
      data: null,
    };
  }

  // Check for conflicting fields
  if (inputType === 'html' && body.markdown) {
    return {
      isValid: false,
      error: BadRequest.CONFLICTING_FIELDS('html'),
      data: null,
    };
  }

  if (inputType === 'markdown' && body.html) {
    return {
      isValid: false,
      error: BadRequest.CONFLICTING_FIELDS('markdown'),
      data: null,
    };
  }

  // Validate content type (basic check for HTML)
  if (inputType === 'html') {
    // Check if content looks like HTML (starts with < or <!DOCTYPE)
    const trimmedContent = content.trim();
    if (
      !trimmedContent.startsWith('<') &&
      !trimmedContent.startsWith('<!DOCTYPE') &&
      !trimmedContent.startsWith('<!doctype')
    ) {
      // This might be markdown mislabeled as HTML
      // But we'll allow it - user might know what they're doing
      logger.warn('HTML content does not appear to be HTML', {
        contentPreview: trimmedContent.substring(0, 100),
      });
    }
  }

  // Validate input size
  const contentSizeBytes = Buffer.byteLength(content, 'utf8');
  if (contentSizeBytes > MAX_INPUT_SIZE_BYTES) {
    return {
      isValid: false,
      error: BadRequest.INPUT_SIZE_EXCEEDED(MAX_INPUT_SIZE_MB),
      data: null,
    };
  }

  // Extract options (optional)
  const options = body.options || {};

  // Extract webhook_url (optional, for longjob)
  const webhookUrl = body.webhook_url;

  return {
    isValid: true,
    error: null,
    data: {
      inputType,
      content,
      options,
      webhookUrl,
    },
  };
}

/**
 * Validate webhook URL
 * @param {string} webhookUrl - Webhook URL to validate
 * @returns {object} Validation result with isValid and error
 */
function validateWebhookUrl(webhookUrl) {
  if (!webhookUrl || typeof webhookUrl !== 'string') {
    return {
      isValid: false,
      error: BadRequest.INVALID_WEBHOOK_URL(),
    };
  }

  try {
    const url = new URL(webhookUrl);
    
    // Must be HTTPS
    if (url.protocol !== 'https:') {
      return {
        isValid: false,
        error: BadRequest.INVALID_WEBHOOK_URL(),
      };
    }

    return {
      isValid: true,
      error: null,
    };
  } catch (error) {
    return {
      isValid: false,
      error: BadRequest.INVALID_WEBHOOK_URL(),
    };
  }
}

module.exports = {
  validateRequestBody,
  validateWebhookUrl,
  MAX_INPUT_SIZE_BYTES,
  MAX_INPUT_SIZE_MB,
};

