/**
 * Server-only helper for locating the checkout-block-validation app
 * Validation resource. Mirrors app/lib/discount.server.js's
 * findFreeGiftDiscountNode: the discount-lookup query lives in one place
 * there, and this is the equivalent single place for the validation
 * lookup, used by the seed script (scripts/seed-checkout-blocklist.mjs) to
 * find the ownerId for its metafieldsSet write.
 *
 * A Validation resource only exists once a merchant activates the rule in
 * Admin > Settings > Checkout > Checkout rules, which happens after this
 * function extension is deployed. Until then, this returns null.
 *
 * Reading `validations` requires the `read_validations` access scope;
 * writing its metafield (see scripts/seed-checkout-blocklist.mjs) requires
 * `write_validations`. Both are declared in
 * shopify.app.free-gift-discount.toml alongside `read_customers` (needed
 * for the function's own `hasAnyTag` check at runtime).
 */

const FUNCTION_TITLE = "checkout-block-validation";
const METAFIELD_NAMESPACE = "$app:checkout-block";
const METAFIELD_KEY = "config";

/**
 * Finds the Validation resource for this app's checkout-block-validation
 * function, if the merchant has activated it.
 *
 * @param {{ graphql: (query: string, options?: object) => Promise<Response> }} admin - the `admin` client from `authenticate.admin(request)` (or `unauthenticated.admin(shop)`)
 * @returns {Promise<{ id: string, metafieldJsonValue: unknown } | null>}
 */
export async function findCheckoutBlockValidationNode(admin) {
  const functionsResponse = await admin.graphql(`
    query CheckoutBlockValidationFunction {
      shopifyFunctions(first: 20) {
        nodes {
          id
          title
        }
      }
    }
  `);
  const functionsJson = await functionsResponse.json();
  const checkoutBlockFunction = functionsJson.data.shopifyFunctions.nodes.find(
    (fn) => fn.title === FUNCTION_TITLE
  );

  if (!checkoutBlockFunction) {
    return null;
  }

  const validationsResponse = await admin.graphql(
    `
      query CheckoutBlockValidationNodes {
        validations(first: 25) {
          nodes {
            id
            enabled
            shopifyFunction {
              id
            }
            metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
              jsonValue
            }
          }
        }
      }
    `
  );
  const validationsJson = await validationsResponse.json();
  const nodes = validationsJson.data.validations.nodes;

  const match = nodes.find(
    (node) => node.shopifyFunction.id === checkoutBlockFunction.id
  );

  if (!match) {
    return null;
  }

  return {
    id: match.id,
    enabled: match.enabled,
    metafieldJsonValue: match.metafield?.jsonValue ?? null,
  };
}

export const CHECKOUT_BLOCK_METAFIELD_NAMESPACE = METAFIELD_NAMESPACE;
export const CHECKOUT_BLOCK_METAFIELD_KEY = METAFIELD_KEY;
