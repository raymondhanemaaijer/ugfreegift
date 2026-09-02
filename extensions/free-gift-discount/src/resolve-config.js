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
 * @param {unknown} config
 * @returns {boolean}
 */
function isValidConfig(config) {
  if (!config || typeof config !== "object") return false;
  if (config.version !== 1) return false;
  if (!config.default || typeof config.default !== "object") return false;
  if (!isValidTiers(config.default.tiers)) return false;
  if (config.markets !== undefined && !Array.isArray(config.markets)) return false;

  return true;
}

/**
 * Resolves the tier list to use for a cart, given the raw metafield JSON
 * value (if any) and the buyer's country ISO code.
 *
 * Resolution order:
 *  1. A `markets[]` entry whose `countryCodes` includes the buyer's country,
 *     `enabled === true`, and whose own `tiers` are valid.
 *  2. `default.tiers`, if valid.
 *  3. BUILTIN_DEFAULT_TIERS, as a final safety net (also used when the
 *     metafield is missing or malformed in any way).
 *
 * @param {{ metafieldJsonValue: unknown, countryIsoCode: string | null | undefined }} args
 * @returns {{id: string, label: string, threshold: number, variantIds: string[]}[]}
 */
export function resolveConfig({ metafieldJsonValue, countryIsoCode }) {
  if (!isValidConfig(metafieldJsonValue)) {
    return BUILTIN_DEFAULT_TIERS;
  }

  const config = metafieldJsonValue;
  const markets = Array.isArray(config.markets) ? config.markets : [];

  if (countryIsoCode) {
    const marketMatch = markets.find(
      (market) =>
        market &&
        typeof market === "object" &&
        market.enabled === true &&
        Array.isArray(market.countryCodes) &&
        market.countryCodes.includes(countryIsoCode) &&
        isValidTiers(market.tiers)
    );

    if (marketMatch) {
      return marketMatch.tiers;
    }
  }

  if (isValidTiers(config.default.tiers)) {
    return config.default.tiers;
  }

  return BUILTIN_DEFAULT_TIERS;
}
