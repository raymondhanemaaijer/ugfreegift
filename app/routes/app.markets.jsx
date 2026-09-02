import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  findFreeGiftDiscountNode,
  FREE_GIFT_METAFIELD_NAMESPACE,
  FREE_GIFT_METAFIELD_KEY,
} from "../lib/discount.server";
import { BUILTIN_DEFAULT_TIERS } from "../lib/builtin-default";

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

function normalizeConfig(rawJsonValue) {
  if (
    rawJsonValue &&
    typeof rawJsonValue === "object" &&
    rawJsonValue.version === 1 &&
    rawJsonValue.default &&
    isValidTiers(rawJsonValue.default.tiers)
  ) {
    return {
      version: 1,
      default: { tiers: rawJsonValue.default.tiers },
      markets: Array.isArray(rawJsonValue.markets) ? rawJsonValue.markets : [],
    };
  }

  // No metafield yet, or it's malformed: pre-fill from the current live
  // (builtin) setup so the UI reflects reality on first load.
  return {
    version: 1,
    default: { tiers: BUILTIN_DEFAULT_TIERS },
    markets: [],
  };
}

/**
 * Server-side guard before writing the metafield: the function falls back to
 * builtin defaults on a malformed config, so a bad save would silently
 * disable every custom tier. Return a message describing the first problem,
 * or null when the config is safe to store.
 */
function validateConfig(config) {
  if (!config || typeof config !== "object" || config.version !== 1) {
    return "Invalid config payload.";
  }
  if (!config.default || !isValidTiers(config.default.tiers)) {
    return "Default needs at least one tier.";
  }
  const describeTiers = (tiers, scope) => {
    for (const tier of tiers) {
      if (!tier.label.trim()) return `${scope}: every tier needs a label.`;
      if (!(tier.threshold >= 0)) return `${scope}: thresholds must be 0 or higher.`;
      if (tier.variantIds.length === 0) {
        return `${scope}: tier "${tier.label}" has no gift products.`;
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
        return `${market.name || market.handle}: custom markets need at least one tier.`;
      }
      const problem = describeTiers(market.tiers, market.name || market.handle);
      if (problem) return problem;
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

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const discountNode = await findFreeGiftDiscountNode(admin);

  if (!discountNode) {
    return { discountNode: null, config: null, markets: [], variantLookup: {} };
  }

  const config = normalizeConfig(discountNode.metafieldJsonValue);

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
  const markets = marketsJson.data.markets.nodes.map((node) => ({
    handle: node.handle,
    name: node.name,
    currency: node.currencySettings?.baseCurrency?.currencyCode || "USD",
    countryCodes: (node.conditions?.regionsCondition?.regions?.nodes || [])
      .map((region) => region.code)
      .filter(Boolean),
  }));

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

  return { discountNode, config, markets, variantLookup };
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

  const config = await request.json();
  const validationError = validateConfig(config);

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

  return { success: true, message: "Saved" };
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
    label: "New tier",
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

  const isSaving = fetcher.state === "submitting";
  const isDirty = config ? JSON.stringify(config) !== savedSnapshot : false;

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Saved");
      setSavedSnapshot(JSON.stringify(config));
    } else if (fetcher.data?.success === false) {
      shopify.toast.show(fetcher.data.message || "Something went wrong", {
        isError: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data]);

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
            back here to configure thresholds and gift products per market.
          </s-paragraph>
        </s-section>
      </s-page>
    );
  }

  const selectedConfigEntry =
    selectedKey === DEFAULT_KEY ? config.default : marketConfigByHandle[selectedKey];
  const isCustom = selectedKey !== DEFAULT_KEY && Boolean(selectedConfigEntry?.enabled);
  const tiers =
    selectedKey === DEFAULT_KEY
      ? config.default.tiers
      : isCustom
        ? selectedConfigEntry.tiers
        : config.default.tiers;

  function updateDefaultTiers(updater) {
    setConfig((prev) => ({ ...prev, default: { tiers: updater(prev.default.tiers) } }));
  }

  function updateMarketTiers(handle, updater) {
    setConfig((prev) => ({
      ...prev,
      markets: prev.markets.map((market) =>
        market.handle === handle ? { ...market, tiers: updater(market.tiers) } : market
      ),
    }));
  }

  function updateTiers(updater) {
    if (selectedKey === DEFAULT_KEY) {
      updateDefaultTiers(updater);
    } else {
      updateMarketTiers(selectedKey, updater);
    }
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
    updateTiers(() => JSON.parse(JSON.stringify(config.default.tiers)));
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

  function save() {
    fetcher.submit(JSON.stringify(config), {
      method: "POST",
      encType: "application/json",
    });
  }

  return (
    <s-page heading="Markets">
      <s-section heading="Free gift configuration by market">
        <s-stack direction="inline" gap="large">
          <s-box minInlineSize="240px" maxInlineSize="280px">
            <s-stack direction="block" gap="small-100">
              <s-clickable-chip
                color={selectedKey === DEFAULT_KEY ? "strong" : "base"}
                onClick={() => setSelectedKey(DEFAULT_KEY)}
              >
                Default (all other markets)
              </s-clickable-chip>
              {markets.map((market) => {
                const custom = Boolean(marketConfigByHandle[market.handle]?.enabled);
                return (
                  <s-clickable-chip
                    key={market.handle}
                    color={selectedKey === market.handle ? "strong" : "base"}
                    onClick={() => setSelectedKey(market.handle)}
                  >
                    {market.name} ({market.currency}){custom ? " · Custom" : ""}
                  </s-clickable-chip>
                );
              })}
            </s-stack>
          </s-box>

          <s-box minInlineSize="0" inlineSize="100%">
            <s-stack direction="block" gap="base">
              {selectedKey !== DEFAULT_KEY && selectedMarket && (
                <s-stack direction="inline" gap="small-100" alignItems="center">
                  <s-switch
                    label="Custom tiers"
                    labelAccessibilityVisibility="exclusive"
                    {...(isCustom ? { checked: true } : {})}
                    onInput={(event) => toggleCustom(selectedMarket, event.target.checked)}
                  />
                  <s-text>
                    {isCustom
                      ? "Custom tiers for this market"
                      : "Uses default tiers (toggle on to customize)"}
                  </s-text>
                </s-stack>
              )}

              {(selectedKey === DEFAULT_KEY || isCustom) && (
                <s-stack direction="block" gap="base">
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
                            label="Label"
                            value={tier.label}
                            onInput={(event) => setTierField(index, "label", event.target.value)}
                          />
                          <s-number-field
                            label={`Threshold (${
                              selectedKey === DEFAULT_KEY
                                ? "EUR"
                                : selectedMarket?.currency || "EUR"
                            })`}
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
                            Remove tier
                          </s-button>
                        </s-stack>

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
                          Add products
                        </s-button>
                      </s-stack>
                    </s-box>
                  ))}

                  <s-stack direction="inline" gap="small-100">
                    <s-button variant="secondary" onClick={addTier}>
                      Add tier
                    </s-button>
                    {selectedKey !== DEFAULT_KEY && (
                      <s-button variant="tertiary" onClick={copyFromDefault}>
                        Copy from default
                      </s-button>
                    )}
                  </s-stack>
                </s-stack>
              )}
            </s-stack>
          </s-box>
        </s-stack>

        <s-box padding="base">
          <s-button
            onClick={save}
            {...(isSaving ? { loading: true } : {})}
            {...(isDirty ? {} : { disabled: true })}
          >
            Save
          </s-button>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
