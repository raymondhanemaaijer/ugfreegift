/**
 * Pure config-resolution logic for the free gift discount function.
 *
 * Kept free of any Shopify/generated-API imports so it can be unit tested
 * with plain vitest, without requiring `shopify app function build` (which
 * produces the wasm bundle and generated/api.js) to have run first.
 *
 * Mirrors app/lib/builtin-default.js in the admin app — see the comment
 * there for why the data is duplicated instead of imported across the
 * app/<->extensions boundary.
 *
 * Config versions:
 *  - version 1: { version: 1, default: { tiers }, markets: [{ ...tiers }] }
 *  - version 2: adds a `freeShipping` block alongside `tiers`, both on
 *    `default` and (optionally) on each market entry: { enabled, threshold }.
 * `resolveConfig` always returns { tiers, freeShipping }; a version 1 config
 * (or anything malformed) resolves `freeShipping` to BUILTIN_DEFAULT_FREE_SHIPPING,
 * which mirrors today's live 60 EUR shipping-rate-condition behaviour as a
 * safety net.
 */

/** @type {{id: string, label: string, threshold: number, variantIds: string[]}[]} */
export const BUILTIN_DEFAULT_TIERS = [
  {
    id: "socks",
    label: "Socks",
    threshold: 60,
    variantIds: [
      "gid://shopify/ProductVariant/64124155494749",
      "gid://shopify/ProductVariant/52540821242205",
    ],
  },
  {
    id: "thong",
    label: "Thong",
    threshold: 80,
    variantIds: [
      "gid://shopify/ProductVariant/62532493443421",
      "gid://shopify/ProductVariant/62532493476189",
      "gid://shopify/ProductVariant/62532493508957",
      "gid://shopify/ProductVariant/62532493541725",
    ],
  },
  {
    id: "shorts",
    label: "Shorts",
    threshold: 110,
    variantIds: [
      "gid://shopify/ProductVariant/64817081418077",
      "gid://shopify/ProductVariant/64659950371165",
      "gid://shopify/ProductVariant/64659950403933",
      "gid://shopify/ProductVariant/64659950436701",
    ],
  },
];

/** @type {{enabled: boolean, threshold: number}} */
export const BUILTIN_DEFAULT_FREE_SHIPPING = { enabled: true, threshold: 60 };

/**
 * @param {unknown} tiers
 * @returns {boolean}
 */
function isValidTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return false;

  return tiers.every((tier) => {
    if (!tier || typeof tier !== "object") return false;

    const { id, label, threshold, variantIds } = tier;

    if (typeof id !== "string" || id.length === 0) return false;
    if (typeof label !== "string" || label.length === 0) return false;
    if (typeof threshold !== "number" || Number.isNaN(threshold) || threshold < 0) {
      return false;
    }
    if (!Array.isArray(variantIds) || variantIds.length === 0) return false;
    if (!variantIds.every((variantId) => typeof variantId === "string" && variantId.length > 0)) {
      return false;
    }

    return true;
  });
}

/**
 * @param {unknown} fs
 * @returns {boolean}
 */
function isValidFreeShipping(fs) {
  if (!fs || typeof fs !== "object") return false;
  if (typeof fs.enabled !== "boolean") return false;
  if (typeof fs.threshold !== "number" || Number.isNaN(fs.threshold) || fs.threshold < 0) {
    return false;
  }
  return true;
}

/**
 * @param {unknown} config
 * @returns {boolean}
 */
function isValidConfig(config) {
  if (!config || typeof config !== "object") return false;
  if (config.version !== 1 && config.version !== 2) return false;
  if (!config.default || typeof config.default !== "object") return false;
  if (!isValidTiers(config.default.tiers)) return false;
  if (config.markets !== undefined && !Array.isArray(config.markets)) return false;

  if (config.version === 2) {
    if (!isValidFreeShipping(config.default.freeShipping)) return false;
  }

  return true;
}

/**
 * Resolves the tiers and free-shipping settings to use for a cart, given the
 * raw metafield JSON value (if any) and the buyer's country ISO code. Each is
 * resolved independently so a version 1 config (no freeShipping at all) keeps
 * working untouched, falling back to BUILTIN_DEFAULT_FREE_SHIPPING.
 *
 * Resolution order (per field):
 *  1. A `markets[]` entry whose `countryCodes` includes the buyer's country,
 *     `enabled === true`, and whose own value is valid.
 *  2. `default`'s value, if valid.
 *  3. The builtin default, as a final safety net (also used when the
 *     metafield is missing or malformed in any way).
 *
 * @param {{ metafieldJsonValue: unknown, countryIsoCode: string | null | undefined }} args
 * @returns {{
 *   tiers: {id: string, label: string, threshold: number, variantIds: string[]}[],
 *   freeShipping: {enabled: boolean, threshold: number},
 * }}
 */
export function resolveConfig({ metafieldJsonValue, countryIsoCode }) {
  if (!isValidConfig(metafieldJsonValue)) {
    return { tiers: BUILTIN_DEFAULT_TIERS, freeShipping: BUILTIN_DEFAULT_FREE_SHIPPING };
  }

  const config = metafieldJsonValue;
  const markets = Array.isArray(config.markets) ? config.markets : [];
  const marketMatch = countryIsoCode
    ? markets.find(
        (market) =>
          market &&
          typeof market === "object" &&
          market.enabled === true &&
          Array.isArray(market.countryCodes) &&
          market.countryCodes.includes(countryIsoCode)
      )
    : undefined;

  let tiers = BUILTIN_DEFAULT_TIERS;
  if (marketMatch && isValidTiers(marketMatch.tiers)) {
    tiers = marketMatch.tiers;
  } else if (isValidTiers(config.default.tiers)) {
    tiers = config.default.tiers;
  }

  let freeShipping = BUILTIN_DEFAULT_FREE_SHIPPING;
  if (marketMatch && isValidFreeShipping(marketMatch.freeShipping)) {
    freeShipping = marketMatch.freeShipping;
  } else if (isValidFreeShipping(config.default.freeShipping)) {
    freeShipping = config.default.freeShipping;
  }

  return { tiers, freeShipping };
}
