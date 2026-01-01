/**
 * ULID utility
 * Generates ULID (Universally Unique Lexicographically Sortable Identifier)
 */

const { ulid } = require('ulid');

/**
 * Generate a new ULID
 * @returns {string} ULID string (e.g., "01ARZ3NDEKTSV4RRFFQ69G5FAV")
 */
function generateULID() {
  return ulid();
}

module.exports = {
  generateULID,
};

