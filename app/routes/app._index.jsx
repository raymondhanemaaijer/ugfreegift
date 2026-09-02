import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { findFreeGiftDiscountNode } from "../lib/discount.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const discountNode = await findFreeGiftDiscountNode(admin);

  return { discountNode };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Re-check before creating: another request (or a previous click) may
  // have already created the discount, and this keeps the action idempotent.
  const existing = await findFreeGiftDiscountNode(admin);

  if (existing) {
    return {
      success: false,
      message: "Discount already exists",
    };
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
    return {
      success: false,
      message: "Free gift function was not found.",
    };
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
    {
      variables: {
        functionId: freeGiftFunction.id,
      },
    }
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
};

export default function Index() {
  const { discountNode } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const isLoading = fetcher.state === "submitting";
  const justCreated = fetcher.data?.success && fetcher.data.discount;

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show("Free Gift Discount created");
    }

    if (fetcher.data?.success === false) {
      shopify.toast.show(fetcher.data.message || "Something went wrong", {
        isError: true,
      });
    }
  }, [fetcher.data, shopify]);

  const createDiscount = () => {
    fetcher.submit({}, { method: "POST" });
  };

  const found = justCreated || discountNode;

  return (
    <s-page heading="Free Gift Discount">
      <s-section heading="Automatic discount status">
        {found ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-badge tone={found.status === "ACTIVE" ? "success" : "warning"}>
                {found.status === "ACTIVE" ? "Active" : found.status || "Inactive"}
              </s-badge>{" "}
              {found.title || "Free Gift Discount"} is set up for this store.
            </s-paragraph>
            <s-paragraph>
              Manage per-market thresholds and gift products on the{" "}
              <s-link href="/app/markets">Markets</s-link> page.
            </s-paragraph>
          </s-stack>
        ) : (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              No automatic Free Gift Discount exists yet for this store. Create it
              once, then configure thresholds and gift products per market.
            </s-paragraph>
            <s-button onClick={createDiscount} {...(isLoading ? { loading: true } : {})}>
              Create Free Gift Discount
            </s-button>
          </s-stack>
        )}

        {fetcher.data?.message && !fetcher.data?.success && (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-paragraph>{fetcher.data.message}</s-paragraph>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
