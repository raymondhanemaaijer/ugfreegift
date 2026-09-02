/**
 * Server-only helper for locating the free-gift-discount automatic app
 * discount node. Shared by the Home page (create/status) and the Markets
 * page (edit its config metafield) so the discount-lookup query only lives
 * in one place.
 */

const FUNCTION_TITLE = "free-gift-discount";
const METAFIELD_NAMESPACE = "$app:free-gift";
const METAFIELD_KEY = "config";

/**
 * Finds the DiscountNode for this app's free gift function, if the merchant
 * has created it.
 *
 * Uses `discountNodes` (not `automaticDiscountNodes`) because the latter is
 * not exposed by this Admin API version at all — `discountNodes` is the
 * supported field for querying app discounts. `first: 50` (not the more
 * typical 10) because Ultimate Gainz also runs Moonbundle, which creates its
 * own app-type discounts under the same `type:app` query filter — a
 * first-page-of-10 miss here would make the Home page's create action think
 * no discount exists and create a duplicate, exactly the failure this
 * idempotency check exists to prevent. (Still a theoretical page-2 miss past
 * 50 app-type discounts; acceptable at current scale.)
 *
 * @param {{ graphql: (query: string, options?: object) => Promise<Response> }} admin - the `admin` client from `authenticate.admin(request)`
 * @returns {Promise<{ id: string, title: string, status: string, functionId: string, metafieldJsonValue: unknown } | null>}
 */
export async function findFreeGiftDiscountNode(admin) {
  const functionsResponse = await admin.graphql(`
    query FreeGiftFunction {
      shopifyFunctions(first: 20) {
        nodes {
          id
          title
        }
      }
    }
  `);
  const functionsJson = await functionsResponse.json();
  const freeGiftFunction = functionsJson.data.shopifyFunctions.nodes.find(
    (fn) => fn.title === FUNCTION_TITLE
  );

  if (!freeGiftFunction) {
    return null;
  }

  const discountsResponse = await admin.graphql(
    `
      query FreeGiftDiscountNodes {
        discountNodes(first: 50, query: "type:app") {
          nodes {
            id
            discount {
              __typename
              ... on DiscountAutomaticApp {
                title
                status
                appDiscountType {
                  functionId
                }
              }
            }
            metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
              jsonValue
            }
          }
        }
      }
    `
  );
  const discountsJson = await discountsResponse.json();
  const nodes = discountsJson.data.discountNodes.nodes;

  const match = nodes.find(
    (node) =>
      node.discount.__typename === "DiscountAutomaticApp" &&
      node.discount.appDiscountType.functionId === freeGiftFunction.id
  );

  if (!match) {
    return null;
  }

  return {
    id: match.id,
    title: match.discount.title,
    status: match.discount.status,
    functionId: match.discount.appDiscountType.functionId,
    metafieldJsonValue: match.metafield?.jsonValue ?? null,
  };
}

export const FREE_GIFT_METAFIELD_NAMESPACE = METAFIELD_NAMESPACE;
export const FREE_GIFT_METAFIELD_KEY = METAFIELD_KEY;
