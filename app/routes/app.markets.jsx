import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge, SaveBar } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  findFreeGiftDiscountNode,
  FREE_GIFT_METAFIELD_NAMESPACE,
  FREE_GIFT_METAFIELD_KEY,
} from "../lib/discount.server";
import { writeShopMetafieldMirror } from "../lib/shop-metafield.server";
import { BUILTIN_DEFAULT_TIERS, BUILTIN_DEFAULT_FREE_SHIPPING } from "../lib/builtin-default";

const DEFAULT_KEY = "default";

function isValidTiers(tiers) {
  return (
    Array.isArray(tiers) &&
    tiers.length > 0 &&
    tiers.every(
      (tier) =>
        tier &&
        typeof tier.id === "string" &&
        typeof tier.label === "string" &&
        typeof tier.threshold === "number" &&
        Array.isArray(tier.variantIds) &&
        tier.variantIds.every((id) => typeof id === "string")
    )
  );
}

function isValidFreeShipping(freeShipping) {
  return (
    freeShipping &&
    typeof freeShipping === "object" &&
    typeof freeShipping.enabled === "boolean" &&
    typeof freeShipping.threshold === "number" &&
    freeShipping.threshold >= 0
  );
}

/**
 * Accepts a raw metafield JSON value of either version and always returns an
 * in-memory version 2 shape: `default.freeShipping` present, and each market
 * entry carries its own `freeShipping` only when it is a custom entry (the
 * function falls back to `default.freeShipping` for anything else, same as
 * tiers).
 */
function normalizeConfig(rawJsonValue) {
  if (
    rawJsonValue &&
    typeof rawJsonValue === "object" &&
    (rawJsonValue.version === 1 || rawJsonValue.version === 2) &&
    rawJsonValue.default &&
    isValidTiers(rawJsonValue.default.tiers)
  ) {
    const defaultFreeShipping = isValidFreeShipping(rawJsonValue.default.freeShipping)
      ? rawJsonValue.default.freeShipping
      : { ...BUILTIN_DEFAULT_FREE_SHIPPING };

    const markets = Array.isArray(rawJsonValue.markets)
      ? rawJsonValue.markets.map((market) => ({
          ...market,
          freeShipping: isValidFreeShipping(market.freeShipping)
            ? market.freeShipping
            : { ...defaultFreeShipping },
        }))
      : [];

    return {
      version: 2,
      default: { tiers: rawJsonValue.default.tiers, freeShipping: defaultFreeShipping },
      markets,
    };
  }

  // No metafield yet, or it's malformed: pre-fill from the current live
  // (builtin) setup so the UI reflects reality on first load.
  return {
    version: 2,
    default: { tiers: BUILTIN_DEFAULT_TIERS, freeShipping: { ...BUILTIN_DEFAULT_FREE_SHIPPING } },
    markets: [],
  };
}

/**
 * Markets whose currency is not the shop's primary (EUR) can never follow
 * the Default tiers/threshold, since those are entered in EUR: a Polish
 * zloty cart could never cross a EUR number. Every such market must always
 * carry its own enabled, custom entry. This adds a placeholder entry (a 1:1
 * numeric copy of the Default amounts, with the market's own currency) for
 * any non-EUR market the live Markets API knows about but that has no saved
 * entry yet. It never touches an existing entry, and it never invents a
 * value for Italy or any other EUR market.
 *
 * Runs both when the page loads (so the merchant immediately sees every
 * non-EUR market as already set up) and again right before a save (so a
 * save made before this page ever ran a currency's full market list still
 * ends up with every non-EUR market seeded).
 */
function seedNonEuroMarkets(config, liveMarkets) {
  const existingHandles = new Set(config.markets.map((market) => market.handle));
  const additions = liveMarkets
    .filter((market) => market.currency !== "EUR" && !existingHandles.has(market.handle))
    .map((market) => ({
      handle: market.handle,
      name: market.name,
      currency: market.currency,
      countryCodes: market.countryCodes,
      enabled: true,
      tiers: JSON.parse(JSON.stringify(config.default.tiers)),
      freeShipping: { ...config.default.freeShipping },
    }));

  if (!additions.length) return config;

  return { ...config, markets: [...config.markets, ...additions] };
}

/**
 * Server-side guard before writing the metafield: the function falls back to
 * builtin defaults on a malformed config, so a bad save would silently
 * disable every custom tier or threshold. Returns a message describing the
 * first problem, or null when the config is safe to store.
 */
function validateConfig(config, liveMarkets) {
  if (!config || typeof config !== "object" || config.version !== 2) {
    return "Invalid config payload.";
  }
  if (!config.default || !isValidTiers(config.default.tiers)) {
    return "Default needs at least one gift.";
  }
  if (!isValidFreeShipping(config.default.freeShipping)) {
    return "Default needs a valid free shipping threshold.";
  }

  const describeTiers = (tiers, scope) => {
    for (const tier of tiers) {
      if (!tier.label.trim()) return `${scope}: every gift needs a name.`;
      if (!(tier.threshold >= 0)) return `${scope}: amounts must be 0 or higher.`;
      if (tier.variantIds.length === 0) {
        return `${scope}: gift "${tier.label}" has no products selected.`;
      }
    }
    return null;
  };
  const defaultProblem = describeTiers(config.default.tiers, "Default");
  if (defaultProblem) return defaultProblem;

  if (!Array.isArray(config.markets)) return "Invalid markets list.";

  for (const market of config.markets) {
    if (
      !market ||
      typeof market.handle !== "string" ||
      typeof market.enabled !== "boolean" ||
      !Array.isArray(market.countryCodes)
    ) {
      return "Invalid market entry.";
    }
    if (market.enabled) {
      if (!isValidTiers(market.tiers)) {
        return `${market.name || market.handle}: custom markets need at least one gift.`;
      }
      if (!isValidFreeShipping(market.freeShipping)) {
        return `${market.name || market.handle}: needs a valid free shipping threshold.`;
      }
      const problem = describeTiers(market.tiers, market.name || market.handle);
      if (problem) return problem;
    }
  }

  const marketsByHandle = new Map(config.markets.map((market) => [market.handle, market]));
  for (const liveMarket of liveMarkets) {
    if (liveMarket.currency === "EUR") continue;
    const entry = marketsByHandle.get(liveMarket.handle);
    if (!entry || entry.enabled !== true) {
      return `${liveMarket.name}: a non-EUR market must always keep its own amounts; it cannot follow the Default or be turned off.`;
    }
  }

  return null;
}

function collectVariantIds(config) {
  const ids = new Set();
  for (const tier of config.default.tiers) {
    for (const id of tier.variantIds) ids.add(id);
  }
  for (const market of config.markets) {
    for (const tier of market.tiers || []) {
      for (const id of tier.variantIds) ids.add(id);
    }
  }
  return [...ids];
}

async function fetchLiveMarkets(admin) {
  const marketsResponse = await admin.graphql(`
    query FreeGiftMarkets {
      markets(first: 250, query: "status:ACTIVE") {
        nodes {
          id
          handle
          name
          currencySettings {
            baseCurrency {
              currencyCode
            }
          }
          conditions {
            regionsCondition {
              regions(first: 250) {
                nodes {
                  ... on MarketRegionCountry {
                    code
                  }
                }
              }
            }
          }
        }
      }
    }
  `);
  const marketsJson = await marketsResponse.json();
  return marketsJson.data.markets.nodes.map((node) => ({
    handle: node.handle,
    name: node.name,
    currency: node.currencySettings?.baseCurrency?.currencyCode || "USD",
    countryCodes: (node.conditions?.regionsCondition?.regions?.nodes || [])
      .map((region) => region.code)
      .filter(Boolean),
  }));
}

const CURRENCY_SYMBOLS = { EUR: "€", USD: "$", GBP: "£" };
function currencySymbol(currency) {
  return CURRENCY_SYMBOLS[currency] || `${currency} `;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const discountNode = await findFreeGiftDiscountNode(admin);

  if (!discountNode) {
    return { discountNode: null, config: null, markets: [], variantLookup: {} };
  }

  const liveMarkets = await fetchLiveMarkets(admin);
  const config = seedNonEuroMarkets(normalizeConfig(discountNode.metafieldJsonValue), liveMarkets);

  const variantIds = collectVariantIds(config);
  let variantLookup = {};

  if (variantIds.length) {
    const variantsResponse = await admin.graphql(
      `
        query FreeGiftVariants($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              title
              price
              product {
                title
                featuredImage {
                  url
                }
              }
            }
          }
        }
      `,
      { variables: { ids: variantIds } }
    );
    const variantsJson = await variantsResponse.json();
    variantLookup = Object.fromEntries(
      (variantsJson.data.nodes || [])
        .filter(Boolean)
        .map((node) => [
          node.id,
          {
            productTitle: node.product?.title || "",
            variantTitle: node.title || "",
            price: node.price || "",
            imageUrl: node.product?.featuredImage?.url || "",
          },
        ])
    );
  }

  return { discountNode, config, markets: liveMarkets, variantLookup };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const discountNode = await findFreeGiftDiscountNode(admin);

  if (!discountNode) {
    return {
      success: false,
      message: "No Free Gift Discount found. Create it from Home first.",
    };
  }

  const liveMarkets = await fetchLiveMarkets(admin);
  const submitted = await request.json();
  const config = seedNonEuroMarkets(submitted, liveMarkets);
  const validationError = validateConfig(config, liveMarkets);

  if (validationError) {
    return { success: false, message: validationError };
  }

  const response = await admin.graphql(
    `
      mutation SetFreeGiftConfig($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        metafields: [
          {
            ownerId: discountNode.id,
            namespace: FREE_GIFT_METAFIELD_NAMESPACE,
            key: FREE_GIFT_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(config),
          },
        ],
      },
    }
  );
  const json = await response.json();
  const userErrors = json.data.metafieldsSet.userErrors;

  if (userErrors.length) {
    return { success: false, message: userErrors.map((error) => error.message).join(", ") };
  }

  const mirrorResult = await writeShopMetafieldMirror(admin, config);

  if (!mirrorResult.success) {
    return {
      success: true,
      config,
      message:
        "Saved, but the theme mirror copy failed to save: " +
        mirrorResult.message +
        ". The discount itself is unaffected.",
      mirrorFailed: true,
    };
  }

  return { success: true, config, message: "Saved" };
};

/**
 * React 18 only forwards a handful of native events (click, input, ...) to
 * props on custom elements; the Polaris chip's `remove` event is not one of
 * them, so this wrapper listens on the element itself.
 */
// eslint-disable-next-line react/prop-types
function RemovableChip({ label, onRemove }) {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    node.addEventListener("remove", onRemove);
    return () => node.removeEventListener("remove", onRemove);
  }, [onRemove]);

  return (
    <s-clickable-chip ref={ref} removable>
      {label}
    </s-clickable-chip>
  );
}

function newTier() {
  return {
    id: `tier-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label: "New gift",
    threshold: 0,
    variantIds: [],
  };
}

export default function Markets() {
  const { discountNode, config: loaderConfig, markets, variantLookup } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [config, setConfig] = useState(loaderConfig);
  const [selectedKey, setSelectedKey] = useState(DEFAULT_KEY);
  const [savedSnapshot, setSavedSnapshot] = useState(
    loaderConfig ? JSON.stringify(loaderConfig) : null
  );

  const saveButtonRef = useRef(null);
  const discardButtonRef = useRef(null);

  const isSaving = fetcher.state === "submitting";
  const isDirty = config ? JSON.stringify(config) !== savedSnapshot : false;

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message || "Saved", {
        isError: Boolean(fetcher.data.mirrorFailed),
      });
      if (fetcher.data.config) setConfig(fetcher.data.config);
      setSavedSnapshot(JSON.stringify(fetcher.data.config || config));
    } else if (fetcher.data?.success === false) {
      shopify.toast.show(fetcher.data.message || "Something went wrong", {
        isError: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

  function save() {
    fetcher.submit(JSON.stringify(config), {
      method: "POST",
      encType: "application/json",
    });
  }

  function discard() {
    setConfig(JSON.parse(savedSnapshot));
  }

  useEffect(() => {
    const saveButton = saveButtonRef.current;
    const discardButton = discardButtonRef.current;
    if (!saveButton || !discardButton) return undefined;
    saveButton.addEventListener("click", save);
    discardButton.addEventListener("click", discard);
    return () => {
      saveButton.removeEventListener("click", save);
      discardButton.removeEventListener("click", discard);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, savedSnapshot]);

  const marketConfigByHandle = useMemo(() => {
    if (!config) return {};
    return Object.fromEntries(config.markets.map((market) => [market.handle, market]));
  }, [config]);

  const selectedMarket = useMemo(
    () => markets.find((market) => market.handle === selectedKey) || null,
    [markets, selectedKey]
  );

  if (!discountNode) {
    return (
      <s-page heading="Markets">
        <s-section heading="No discount yet">
          <s-paragraph>
            Create the Free Gift Discount on the{" "}
            <s-link href="/app">Home</s-link> page first. Once it exists, come
            back here to configure free shipping and gift products per market.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const isDefaultSelected = selectedKey === DEFAULT_KEY;
  const selectedConfigEntry = isDefaultSelected
    ? config.default
    : marketConfigByHandle[selectedKey];
  const isLocked = !isDefaultSelected && selectedMarket && selectedMarket.currency !== "EUR";
  const isCustom = isDefaultSelected
    ? true
    : Boolean(selectedConfigEntry?.enabled) || isLocked;
  const editable = isDefaultSelected || isCustom;
  const activeEntry = editable ? selectedConfigEntry : config.default;
  const tiers = activeEntry?.tiers ?? config.default.tiers;
  const freeShipping = activeEntry?.freeShipping ?? config.default.freeShipping;
  const symbol = isDefaultSelected
    ? currencySymbol("EUR")
    : currencySymbol(selectedMarket?.currency || "EUR");

  function updateDefaultEntry(updater) {
    setConfig((prev) => ({ ...prev, default: updater(prev.default) }));
  }

  function updateMarketEntry(handle, updater) {
    setConfig((prev) => ({
      ...prev,
      markets: prev.markets.map((market) =>
        market.handle === handle ? updater(market) : market
      ),
    }));
  }

  function updateEntry(updater) {
    if (isDefaultSelected) {
      updateDefaultEntry(updater);
    } else {
      updateMarketEntry(selectedKey, updater);
    }
  }

  function updateTiers(updater) {
    updateEntry((entry) => ({ ...entry, tiers: updater(entry.tiers) }));
  }

  function updateFreeShipping(updater) {
    updateEntry((entry) => ({ ...entry, freeShipping: updater(entry.freeShipping) }));
  }

  function toggleCustom(market, enabled) {
    setConfig((prev) => {
      const existingIndex = prev.markets.findIndex((m) => m.handle === market.handle);

      if (existingIndex === -1) {
        if (!enabled) return prev;
        return {
          ...prev,
          markets: [
            ...prev.markets,
            {
              handle: market.handle,
              name: market.name,
              currency: market.currency,
              countryCodes: market.countryCodes,
              enabled: true,
              tiers: JSON.parse(JSON.stringify(prev.default.tiers)),
              freeShipping: { ...prev.default.freeShipping },
            },
          ],
        };
      }

      const nextMarkets = [...prev.markets];
      nextMarkets[existingIndex] = { ...nextMarkets[existingIndex], enabled };
      return { ...prev, markets: nextMarkets };
    });
  }

  function copyFromDefault() {
    updateEntry(() => ({
      ...selectedConfigEntry,
      tiers: JSON.parse(JSON.stringify(config.default.tiers)),
      freeShipping: { ...config.default.freeShipping },
    }));
  }

  function addTier() {
    updateTiers((current) => [...current, newTier()]);
  }

  function removeTier(index) {
    updateTiers((current) => current.filter((_, i) => i !== index));
  }

  function setTierField(index, field, value) {
    updateTiers((current) =>
      current.map((tier, i) => (i === index ? { ...tier, [field]: value } : tier))
    );
  }

  function removeVariant(tierIndex, variantId) {
    updateTiers((current) =>
      current.map((tier, i) =>
        i === tierIndex
          ? { ...tier, variantIds: tier.variantIds.filter((id) => id !== variantId) }
          : tier
      )
    );
  }

  async function addProducts(tierIndex) {
    const selection = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      filter: { variants: true },
    });

    if (!selection) return;

    const newVariantIds = selection.flatMap((product) =>
      (product.variants || []).map((variant) => variant.id)
    );

    updateTiers((current) =>
      current.map((tier, i) =>
        i === tierIndex
          ? { ...tier, variantIds: [...new Set([...tier.variantIds, ...newVariantIds])] }
          : tier
      )
    );
  }

  const marketRows = markets.map((market) => {
    const entry = marketConfigByHandle[market.handle];
    const nonEuro = market.currency !== "EUR";
    const custom = nonEuro || Boolean(entry?.enabled);
    return { market, custom };
  });

  const previewSteps = [];
  if (freeShipping.enabled) {
    previewSteps.push({
      amount: freeShipping.threshold,
      when: `From ${symbol}${freeShipping.threshold}`,
      what: "Free shipping",
    });
  }
  for (const tier of tiers) {
    previewSteps.push({
      amount: tier.threshold,
      when: `From ${symbol}${tier.threshold}`,
      what: tier.label,
    });
  }
  previewSteps.sort((a, b) => a.amount - b.amount);

  return (
    <s-page heading="Markets">
      <SaveBar id="free-gift-save-bar" open={isDirty}>
        <button variant="primary" ref={saveButtonRef} {...(isSaving ? { loading: "" } : {})}>
          Save
        </button>
        <button ref={discardButtonRef}>Discard</button>
      </SaveBar>

      <s-section heading="Free gift configuration by market">
        <s-paragraph>
          Set free shipping, gift thresholds and gift products per market.
        </s-paragraph>
        <s-stack direction="inline" gap="large">
          <s-box minInlineSize="240px" maxInlineSize="280px">
            <s-stack direction="block" gap="small-100">
              <s-clickable-chip
                color={isDefaultSelected ? "strong" : "base"}
                onClick={() => setSelectedKey(DEFAULT_KEY)}
              >
                Default (all other euro markets)
              </s-clickable-chip>
              {marketRows.map(({ market, custom }) => (
                <s-clickable-chip
                  key={market.handle}
                  color={selectedKey === market.handle ? "strong" : "base"}
                  onClick={() => setSelectedKey(market.handle)}
                >
                  {market.name} ({market.currency}){custom ? " · Custom" : " · Uses default"}
                </s-clickable-chip>
              ))}
            </s-stack>
          </s-box>

          <s-box minInlineSize="0" inlineSize="100%">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small-100" alignItems="center">
                <s-text><strong>{isDefaultSelected ? "Default" : selectedMarket?.name}</strong></s-text>
                {!isDefaultSelected && selectedMarket && (
                  <s-text tone="subdued">
                    {selectedMarket.currency} {"·"} {selectedMarket.countryCodes.join(", ")}
                  </s-text>
                )}
                {isLocked && <s-badge tone="info">Own amounts per currency</s-badge>}
                {!isDefaultSelected && !isLocked && selectedMarket && (
                  <s-switch
                    label="Use custom settings for this market"
                    labelAccessibilityVisibility="exclusive"
                    {...(isCustom ? { checked: true } : {})}
                    onInput={(event) => toggleCustom(selectedMarket, event.target.checked)}
                  />
                )}
              </s-stack>

              {!isDefaultSelected && !isCustom && (
                <s-box padding="base" background="subdued" borderRadius="base">
                  <s-paragraph>
                    This market follows the Default settings. Turn on custom
                    settings to change shipping or gifts only for{" "}
                    {selectedMarket?.name}.
                  </s-paragraph>
                </s-box>
              )}

              {editable && (
                <>
                  <s-box padding="base" borderWidth="base" borderRadius="base">
                    <s-stack direction="block" gap="small-100">
                      <s-stack direction="inline" gap="small-100" alignItems="center">
                        <s-text><strong>Free shipping</strong></s-text>
                        <s-switch
                          label="Free shipping on or off"
                          labelAccessibilityVisibility="exclusive"
                          {...(freeShipping.enabled ? { checked: true } : {})}
                          onInput={(event) =>
                            updateFreeShipping((fs) => ({ ...fs, enabled: event.target.checked }))
                          }
                        />
                      </s-stack>
                      <s-text tone="subdued">
                        Shipping becomes free when the cart (without gifts)
                        reaches this amount.
                      </s-text>
                      <s-number-field
                        label={`Free from (${symbol.trim()})`}
                        value={String(freeShipping.threshold)}
                        min={0}
                        {...(freeShipping.enabled ? {} : { disabled: true })}
                        onInput={(event) =>
                          updateFreeShipping((fs) => ({
                            ...fs,
                            threshold: Number(event.target.value) || 0,
                          }))
                        }
                      />
                    </s-stack>
                  </s-box>

                  <s-box padding="base" borderWidth="base" borderRadius="base">
                    <s-stack direction="block" gap="base">
                      <s-stack direction="inline" gap="small-100" alignItems="center">
                        <s-text><strong>Free gifts</strong></s-text>
                        <s-button variant="tertiary" onClick={addTier}>
                          Add gift
                        </s-button>
                      </s-stack>
                      <s-text tone="subdued">
                        A gift is free when the cart reaches its amount and
                        holds exactly one gift variant of that group.
                      </s-text>

                      {tiers.map((tier, index) => (
                        <s-box
                          key={tier.id || index}
                          padding="base"
                          borderWidth="base"
                          borderRadius="base"
                        >
                          <s-stack direction="block" gap="small-100">
                            <s-stack direction="inline" gap="small-100">
                              <s-text-field
                                label="Gift name"
                                value={tier.label}
                                onInput={(event) => setTierField(index, "label", event.target.value)}
                              />
                              <s-number-field
                                label={`Free from (${symbol.trim()})`}
                                value={String(tier.threshold)}
                                min={0}
                                onInput={(event) =>
                                  setTierField(index, "threshold", Number(event.target.value) || 0)
                                }
                              />
                              <s-button
                                tone="critical"
                                variant="tertiary"
                                onClick={() => removeTier(index)}
                              >
                                Remove
                              </s-button>
                            </s-stack>

                            <s-text>Gift products</s-text>
                            <s-stack direction="inline" gap="small-100">
                              {tier.variantIds.map((variantId) => {
                                const info = variantLookup[variantId];
                                const label = info
                                  ? `${info.productTitle} - ${info.variantTitle}`
                                  : variantId;
                                return (
                                  <RemovableChip
                                    key={variantId}
                                    label={label}
                                    onRemove={() => removeVariant(index, variantId)}
                                  />
                                );
                              })}
                            </s-stack>

                            <s-button variant="tertiary" onClick={() => addProducts(index)}>
                              Select products
                            </s-button>
                          </s-stack>
                        </s-box>
                      ))}

                      {!isDefaultSelected && (
                        <s-button variant="tertiary" onClick={copyFromDefault}>
                          Copy from default
                        </s-button>
                      )}
                    </s-stack>
                  </s-box>

                  <s-box padding="base" borderWidth="base" borderRadius="base">
                    <s-stack direction="block" gap="small-100">
                      <s-text>
                        <strong>
                          What customers {isDefaultSelected ? "in other euro markets" : `in ${selectedMarket?.name}`} see
                        </strong>
                      </s-text>
                      <s-text tone="subdued">
                        The cart progress bar follows these steps, in{" "}
                        {isDefaultSelected ? "EUR" : selectedMarket?.currency}.
                      </s-text>
                      <s-stack direction="inline" gap="small-100">
                        {previewSteps.map((step, i) => (
                          <s-box key={i} padding="small-100" borderWidth="base" borderRadius="base">
                            <s-text tone="subdued">{step.when}</s-text>
                            <s-text><strong>{step.what}</strong></s-text>
                          </s-box>
                        ))}
                      </s-stack>
                    </s-stack>
                  </s-box>
                </>
              )}
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
