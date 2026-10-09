import { resolveBlocklist } from "./resolve-blocklist";

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} RunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

// Pinned verbatim: this exact text is what the customer sees in checkout
// when blocked, and is asserted verbatim in tests.
const BLOCK_MESSAGE =
  "This order cannot be completed. Please contact help@ultimate-gainz.com.";

/**
 * @param {string | null | undefined} value
 * @returns {string}
 */
function digitsOnly(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\D/g, "");
}

/**
 * @param {RunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  // (a) Hardcoded tag check. This runs independently of the metafield, so
  // it can never be disabled by a metafield problem.
  if (input.cart.buyerIdentity?.customer?.hasAnyTag) {
    return blockResult();
  }

  // (b) Metafield-driven zip + phone-suffix check. Fails open (resolves to
  // an empty list) on any missing or malformed metafield, so a metafield
  // problem can never block everyone.
  const blocklist = resolveBlocklist(
    input.validation.metafield?.jsonValue ?? null
  );

  if (blocklist.length === 0) {
    return { operations: [] };
  }

  const phones = new Set();
  const zips = new Set();

  const buyerPhone = digitsOnly(input.cart.buyerIdentity?.phone);
  if (buyerPhone) phones.add(buyerPhone);

  for (const group of input.cart.deliveryGroups) {
    const address = group.deliveryAddress;
    if (!address) continue;

    const groupPhone = digitsOnly(address.phone);
    if (groupPhone) phones.add(groupPhone);

    const groupZip = digitsOnly(address.zip);
    if (groupZip) zips.add(groupZip);
  }

  for (const entry of blocklist) {
    const entryPhoneSuffix = digitsOnly(entry.phoneSuffix);
    const entryZip = digitsOnly(entry.zip);

    const phoneMatches =
      entryPhoneSuffix.length > 0 &&
      Array.from(phones).some((phone) => phone.endsWith(entryPhoneSuffix));

    const zipMatches = entryZip.length > 0 && zips.has(entryZip);

    if (phoneMatches && zipMatches) {
      return blockResult();
    }
  }

  return { operations: [] };
}

/**
 * @returns {CartValidationsGenerateRunResult}
 */
function blockResult() {
  return {
    operations: [
      {
        validationAdd: {
          errors: [
            {
              message: BLOCK_MESSAGE,
              target: "$.cart",
            },
          ],
        },
      },
    ],
  };
}
