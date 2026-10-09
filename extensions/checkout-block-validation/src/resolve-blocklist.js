/**
 * Pure blocklist-resolution logic for the checkout block validation function.
 *
 * Kept free of any Shopify/generated-API imports so it can be unit tested
 * with plain vitest, without requiring `shopify app function build` (which
 * produces the wasm bundle and generated/api.js) to have run first.
 *
 * Mirrors src/resolve-config.js in the free-gift-discount extension — same
 * pattern and convention: read a JSON config metafield on the function
 * owner, validate its shape defensively, and fall back to a safe empty
 * value on anything unexpected so a missing or malformed metafield can
 * never block a customer.
 *
 * Metafield: namespace "$app:checkout-block", key "config" (a new
 * namespace, distinct from the discount function's "$app:free-gift",
 * since this is a different feature).
 *
 * Shape: an array of { zip: string, phoneSuffix: string } pairs.
 */

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
function isValidEntry(entry) {
  if (!entry || typeof entry !== "object") return false;

  const { zip, phoneSuffix } = entry;

  if (typeof zip !== "string" || zip.length === 0) return false;
  if (typeof phoneSuffix !== "string" || phoneSuffix.length === 0) return false;

  return true;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidBlocklist(value) {
  return Array.isArray(value) && value.every(isValidEntry);
}

/**
 * Resolves the blocklist to use, given the raw metafield JSON value (if
 * any). Any missing metafield, non-array value, or entry failing shape
 * validation resolves to an empty list — never throws, never blocks.
 *
 * @param {unknown} rawJsonValue
 * @returns {{zip: string, phoneSuffix: string}[]}
 */
export function resolveBlocklist(rawJsonValue) {
  if (!isValidBlocklist(rawJsonValue)) {
    return [];
  }

  return rawJsonValue;
}
