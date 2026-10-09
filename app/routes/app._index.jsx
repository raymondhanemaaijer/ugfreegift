import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { findFreeGiftDiscountNode } from "../lib/discount.server";

const SWITCHOVER_NAMESPACE = "free_gift";
const SWITCHOVER_KEY = "old_discount_off";

async function readSwitchoverFlag(admin) {
  const response = await admin.graphql(`
    query FreeGiftSwitchoverFlag {
      shop {
        metafield(namespace: "${SWITCHOVER_NAMESPACE}", key: "${SWITCHOVER_KEY}") {
          value
        }
      }
    }
  `);
  const json = await response.json();
  return json.data?.shop?.metafield?.value === "true";
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const discountNode = await findFreeGiftDiscountNode(admin);
  const oldDiscountOff = await readSwitchoverFlag(admin);

  const marketsResponse = await admin.graphql(`
    query FreeGiftMarketsCount {
      markets(first: 250, query: "status:ACTIVE") {
        nodes {
          id
        }
      }
    }
  `);
  const marketsJson = await marketsResponse.json();
  const totalMarkets = marketsJson.data.markets.nodes.length;

  const customMarketCount = Array.isArray(discountNode?.metafieldJsonValue?.markets)
    ? discountNode.metafieldJsonValue.markets.filter((market) => market?.enabled).length
    : 0;

  return { discountNode, oldDiscountOff, totalMarkets, customMarketCount };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "create-discount") {
    // Re-check before creating: another request (or a previous click) may
    // have already created the discount, and this keeps the action idempotent.
    const existing = await findFreeGiftDiscountNode(admin);

    if (existing) {
      return { success: false, message: "Discount already exists" };
    }

    const functionsResponse = await admin.graphql(`
      query {
        shopifyFunctions(first: 20) {
          nodes {
            id
            title
            apiType
          }
        }
      }
    `);

    const functionsJson = await functionsResponse.json();

    const freeGiftFunction = functionsJson.data.shopifyFunctions.nodes.find(
      (fn) => fn.title === "free-gift-discount"
    );

    if (!freeGiftFunction) {
      return { success: false, message: "Free gift function was not found." };
    }

    const discountResponse = await admin.graphql(
      `
        mutation CreateFreeGiftDiscount($functionId: String!) {
          discountAutomaticAppCreate(
            automaticAppDiscount: {
              title: "Free Gift Discount"
              functionId: $functionId
              startsAt: "2026-01-01T00:00:00Z"
              discountClasses: [PRODUCT]
              combinesWith: {
                productDiscounts: true
                orderDiscounts: true
                shippingDiscounts: true
              }
            }
          ) {
            automaticAppDiscount {
              discountId
              title
              status
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      { variables: { functionId: freeGiftFunction.id } }
    );

    const discountJson = await discountResponse.json();
    const result = discountJson.data.discountAutomaticAppCreate;

    if (result.userErrors.length) {
      return {
        success: false,
        message: result.userErrors.map((error) => error.message).join(", "),
      };
    }

    return {
      success: true,
      discount: result.automaticAppDiscount,
      message: "Free Gift Discount created successfully.",
    };
  }

  if (intent === "confirm-old-discount-off" || intent === "unconfirm-old-discount-off") {
    const shopResponse = await admin.graphql(`
      query FreeGiftShopId {
        shop {
          id
        }
      }
    `);
    const shopJson = await shopResponse.json();
    const shopId = shopJson.data?.shop?.id;

    const response = await admin.graphql(
      `
        mutation SetFreeGiftSwitchoverFlag($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
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
              ownerId: shopId,
              namespace: SWITCHOVER_NAMESPACE,
              key: SWITCHOVER_KEY,
              type: "boolean",
              value: intent === "confirm-old-discount-off" ? "true" : "false",
            },
          ],
        },
      }
    );
    const json = await response.json();
    const userErrors = json.data?.metafieldsSet?.userErrors ?? [];

    if (userErrors.length) {
      return { success: false, message: userErrors.map((error) => error.message).join(", ") };
    }

    return { success: true, message: "Updated" };
  }

  return { success: false, message: "Unknown action." };
};

export default function Index() {
  const { discountNode, oldDiscountOff, totalMarkets, customMarketCount } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const isLoading = fetcher.state === "submitting";
  const justCreated = fetcher.data?.success && fetcher.data.discount;

  useEffect(() => {
    if (fetcher.data?.success) {
      if (fetcher.data.message) shopify.toast.show(fetcher.data.message);
    } else if (fetcher.data?.success === false) {
      shopify.toast.show(fetcher.data.message || "Something went wrong", {
        isError: true,
      });
    }
  }, [fetcher.data, shopify]);

  const createDiscount = () => {
    fetcher.submit({ intent: "create-discount" }, { method: "POST" });
  };

  const toggleOldDiscountOff = () => {
    fetcher.submit(
      { intent: oldDiscountOff ? "unconfirm-old-discount-off" : "confirm-old-discount-off" },
      { method: "POST" }
    );
  };

  const found = justCreated || discountNode;
  const discountActive = found && (found.status === "ACTIVE" || justCreated);
  const marketsConfigured = customMarketCount > 0;

  const steps = [
    {
      title: "Install the new app",
      text: "Approve the permissions for markets and checkout rules.",
      done: true,
      action: null,
    },
    {
      title: "Create the discount",
      text: "One automatic discount that holds all market settings.",
      done: Boolean(discountActive),
      action: discountActive
        ? null
        : { label: "Create discount", onClick: createDiscount },
    },
    {
      title: "Set up your markets",
      text: "Check Italy and every market with its own free shipping or gifts.",
      done: marketsConfigured,
      action: { label: "Open Markets", href: "/app/markets" },
    },
    {
      title: "Turn off the old discount",
      text: "Deactivate the discount from the old developer app. Do this last.",
      done: oldDiscountOff,
      action: {
        label: oldDiscountOff ? "Mark as not done" : "Mark as done",
        onClick: toggleOldDiscountOff,
      },
    },
  ];

  const allDone = steps.every((step) => step.done);
  const liveSoFar = steps[0].done && steps[1].done;

  const badge = allDone
    ? { label: "Active on new app", tone: "success" }
    : liveSoFar
      ? { label: "Both discounts active", tone: "warning" }
      : { label: "Old app active", tone: "warning" };

  const runsOn = allDone ? "This app (ugfreegift)" : liveSoFar ? "Old and new app" : "Old developer app";
  const settingsState = marketsConfigured ? "Per market, live" : "Not set up yet";

  return (
    <s-page heading="Home">
      <s-section heading="Free Gift Discount">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Automatic app discount, runs at checkout in every market.
          </s-paragraph>
          <s-badge tone={badge.tone}>{badge.label}</s-badge>

          <s-stack direction="inline" gap="base">
            <s-box padding="base" borderWidth="base" borderRadius="base" minInlineSize="180px">
              <s-text tone="subdued">Runs on</s-text>
              <s-text><strong>{runsOn}</strong></s-text>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base" minInlineSize="180px">
              <s-text tone="subdued">Market settings</s-text>
              <s-text><strong>{settingsState}</strong></s-text>
            </s-box>
            <s-box padding="base" borderWidth="base" borderRadius="base" minInlineSize="180px">
              <s-text tone="subdued">Custom markets</s-text>
              <s-text><strong>{customMarketCount} of {totalMarkets}</strong></s-text>
            </s-box>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Switch over from the old app">
        <s-paragraph>
          Until all four steps are done, customers still get the old fixed
          ladder (60, 80, 110).
        </s-paragraph>
        <s-stack direction="block" gap="base">
          {steps.map((step, i) => (
            <s-stack key={i} direction="inline" gap="small-100" alignItems="center">
              <s-badge tone={step.done ? "success" : "neutral"}>
                {step.done ? "✓" : String(i + 1)}
              </s-badge>
              <s-box minInlineSize="0" inlineSize="100%">
                <s-text><strong>{step.title}</strong></s-text>
                <s-text tone="subdued">{step.text}</s-text>
              </s-box>
              {step.action &&
                (step.action.href ? (
                  <s-link href={step.action.href}>{step.action.label}</s-link>
                ) : (
                  <s-button
                    variant="tertiary"
                    onClick={step.action.onClick}
                    {...(isLoading ? { loading: true } : {})}
                  >
                    {step.action.label}
                  </s-button>
                ))}
            </s-stack>
          ))}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-paragraph>
          Each market follows the Default settings or has its own. The
          discount reads the buyer&apos;s market at checkout, and the store
          cart reads the same settings, so both always agree.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Different currency, own amounts">
        <s-paragraph>
          Markets with their own currency always keep their own amounts; they
          can never follow the Default (entered in EUR).
        </s-paragraph>
      </s-section>

      {fetcher.data?.message && !fetcher.data?.success && (
        <s-section heading="Error">
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-section>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
