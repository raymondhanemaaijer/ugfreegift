import { describe, test, expect } from "vitest";
import {
  resolveConfig,
  BUILTIN_DEFAULT_TIERS,
  BUILTIN_DEFAULT_FREE_SHIPPING,
} from "../src/resolve-config";

// Plain-vitest tests against the pure resolution logic directly, with no
// @shopify/shopify-function-test-helpers and no wasm build required. This is
// the brief's mandated fallback if `shopify app function build` isn't
// available in this environment (see tests/default.test.js for the
// wasm-integration suite, which exercises the same logic end to end via
// fixtures when the build succeeds).

const validConfigV1 = {
  version: 1,
  default: {
    tiers: [
      {
        id: "socks",
        label: "Socks",
        threshold: 60,
        variantIds: ["gid://shopify/ProductVariant/1"],
      },
    ],
  },
  markets: [
    {
      handle: "italy",
      name: "italy",
      currency: "EUR",
      countryCodes: ["IT"],
      enabled: true,
      tiers: [
        {
          id: "socks",
          label: "Socks IT",
          threshold: 40,
          variantIds: ["gid://shopify/ProductVariant/2"],
        },
      ],
    },
  ],
};

const validConfigV2 = {
  version: 2,
  default: {
    tiers: validConfigV1.default.tiers,
    freeShipping: { enabled: true, threshold: 60 },
  },
  markets: [
    {
      handle: "test-market",
      name: "Test market",
      currency: "EUR",
      countryCodes: ["TM"],
      enabled: true,
      tiers: validConfigV1.markets[0].tiers,
      freeShipping: { enabled: true, threshold: 45 },
    },
  ],
};

describe("resolveConfig - tiers", () => {
  test("missing metafield falls back to builtin defaults", () => {
    const { tiers } = resolveConfig({ metafieldJsonValue: null, countryIsoCode: "NL" });
    expect(tiers).toBe(BUILTIN_DEFAULT_TIERS);
  });

  test("malformed JSON shape falls back to builtin defaults", () => {
    const { tiers } = resolveConfig({
      metafieldJsonValue: { version: 1, default: { tiers: "not-an-array" } },
      countryIsoCode: "NL",
    });
    expect(tiers).toBe(BUILTIN_DEFAULT_TIERS);
  });

  test("market entry matching country and enabled returns its override tiers", () => {
    const { tiers } = resolveConfig({ metafieldJsonValue: validConfigV1, countryIsoCode: "IT" });
    expect(tiers).toBe(validConfigV1.markets[0].tiers);
  });

  test("country matching no market falls back to default tiers", () => {
    const { tiers } = resolveConfig({ metafieldJsonValue: validConfigV1, countryIsoCode: "NL" });
    expect(tiers).toBe(validConfigV1.default.tiers);
  });

  test("matching market entry present but disabled falls back to default tiers", () => {
    const configWithDisabledMarket = {
      ...validConfigV1,
      markets: [{ ...validConfigV1.markets[0], enabled: false }],
    };

    const { tiers } = resolveConfig({
      metafieldJsonValue: configWithDisabledMarket,
      countryIsoCode: "IT",
    });
    expect(tiers).toBe(configWithDisabledMarket.default.tiers);
  });
});

describe("resolveConfig - freeShipping", () => {
  test("version 1 config resolves freeShipping to the builtin default", () => {
    const { freeShipping } = resolveConfig({
      metafieldJsonValue: validConfigV1,
      countryIsoCode: "NL",
    });
    expect(freeShipping).toEqual(BUILTIN_DEFAULT_FREE_SHIPPING);
  });

  test("missing metafield resolves freeShipping to the builtin default", () => {
    const { freeShipping } = resolveConfig({ metafieldJsonValue: null, countryIsoCode: "NL" });
    expect(freeShipping).toEqual(BUILTIN_DEFAULT_FREE_SHIPPING);
  });

  test("version 2 config with no matching market resolves to default.freeShipping", () => {
    const { freeShipping } = resolveConfig({
      metafieldJsonValue: validConfigV2,
      countryIsoCode: "NL",
    });
    expect(freeShipping).toBe(validConfigV2.default.freeShipping);
  });

  test("version 2 config with a matching market resolves to its own freeShipping override", () => {
    // Test-only threshold (45); never Italy's real 30 EUR, which only ever
    // reaches the metafield when Raymond saves it through the UI.
    const { freeShipping } = resolveConfig({
      metafieldJsonValue: validConfigV2,
      countryIsoCode: "TM",
    });
    expect(freeShipping).toBe(validConfigV2.markets[0].freeShipping);
  });

  test("freeShipping.enabled = false is preserved, not coerced to the builtin default", () => {
    const configDisabled = {
      ...validConfigV2,
      default: { ...validConfigV2.default, freeShipping: { enabled: false, threshold: 60 } },
    };
    const { freeShipping } = resolveConfig({
      metafieldJsonValue: configDisabled,
      countryIsoCode: "NL",
    });
    expect(freeShipping).toEqual({ enabled: false, threshold: 60 });
  });

  test("malformed default.freeShipping on a version 2 config falls back to the builtin default", () => {
    const configMalformed = {
      ...validConfigV2,
      default: { ...validConfigV2.default, freeShipping: { enabled: "yes", threshold: -5 } },
    };
    // The whole config is invalid (default.freeShipping fails validation for
    // version 2), so both tiers and freeShipping fall back to builtins.
    const result = resolveConfig({ metafieldJsonValue: configMalformed, countryIsoCode: "NL" });
    expect(result.freeShipping).toEqual(BUILTIN_DEFAULT_FREE_SHIPPING);
    expect(result.tiers).toBe(BUILTIN_DEFAULT_TIERS);
  });

  test("malformed market-level freeShipping falls back to default.freeShipping for that market", () => {
    const configMarketMalformed = {
      ...validConfigV2,
      markets: [{ ...validConfigV2.markets[0], freeShipping: { enabled: true } }],
    };
    const { freeShipping } = resolveConfig({
      metafieldJsonValue: configMarketMalformed,
      countryIsoCode: "TM",
    });
    expect(freeShipping).toBe(configMarketMalformed.default.freeShipping);
  });
});
