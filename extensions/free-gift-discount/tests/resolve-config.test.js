import { describe, test, expect } from "vitest";
import { resolveConfig, BUILTIN_DEFAULT_TIERS } from "../src/resolve-config";

// Plain-vitest tests against the pure resolution logic directly, with no
// @shopify/shopify-function-test-helpers and no wasm build required. This is
// the brief's mandated fallback if `shopify app function build` isn't
// available in this environment (see tests/default.test.js for the
// wasm-integration suite, which exercises the same logic end to end via
// fixtures when the build succeeds).

const validConfig = {
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

describe("resolveConfig", () => {
  test("missing metafield falls back to builtin defaults", () => {
    const tiers = resolveConfig({ metafieldJsonValue: null, countryIsoCode: "NL" });
    expect(tiers).toBe(BUILTIN_DEFAULT_TIERS);
  });

  test("malformed JSON shape falls back to builtin defaults", () => {
    const tiers = resolveConfig({
      metafieldJsonValue: { version: 1, default: { tiers: "not-an-array" } },
      countryIsoCode: "NL",
    });
    expect(tiers).toBe(BUILTIN_DEFAULT_TIERS);
  });

  test("market entry matching country and enabled returns its override tiers", () => {
    const tiers = resolveConfig({ metafieldJsonValue: validConfig, countryIsoCode: "IT" });
    expect(tiers).toBe(validConfig.markets[0].tiers);
  });

  test("country matching no market falls back to default tiers", () => {
    const tiers = resolveConfig({ metafieldJsonValue: validConfig, countryIsoCode: "NL" });
    expect(tiers).toBe(validConfig.default.tiers);
  });

  test("matching market entry present but disabled falls back to default tiers", () => {
    const configWithDisabledMarket = {
      ...validConfig,
      markets: [{ ...validConfig.markets[0], enabled: false }],
    };

    const tiers = resolveConfig({
      metafieldJsonValue: configWithDisabledMarket,
      countryIsoCode: "IT",
    });
    expect(tiers).toBe(configWithDisabledMarket.default.tiers);
  });
});
