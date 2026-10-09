/**
 * Mirrors the resolved free-gift config onto a Shop-level metafield, so a
 * later theme task can read the same thresholds from Liquid (e.g. to show a
 * "free shipping from X" progress bar in the cart drawer, matching whatever
 * the discount function actually applies).
 *
 * Namespace choice: the discount-node metafield (app/lib/discount.server.js)
 * uses the reserved `$app:free-gift` namespace, which is fine there because
 * only this app's own Function reads it. A Shop-level metafield meant for
 * Liquid is different: reserved `$app:` namespaces resolve in the Admin API
 * to `app--<numeric-app-id>--<namespace>`, and whether that resolved field is
 * actually readable from `shop.metafields` in a theme depends on the
 * metafield definition's storefront access, which was not verified against
 * the live store as part of this build (verifying it would mean writing to
 * the live store's Shop resource, which is out of scope for this task). To
 * avoid documenting a namespace that might silently block the later theme
 * task, this mirror deliberately uses a plain, non-reserved namespace/key
 * instead: `free_gift` / `config`. The discount-node metafield is unaffected
 * and keeps `$app:free-gift` (function-only, no Liquid-readability
 * requirement), so the two are decoupled on purpose.
 *
 * Whoever wires up the theme read should first confirm in the Admin
 * (Settings > Custom data > Shop, or a metafieldDefinitionCreate with
 * `access: { storefront: "PUBLIC_READ" }`) that `free_gift.config` is
 * storefront-readable, since a plain namespace is still private by default
 * until a definition grants storefront access.
 */

export const SHOP_METAFIELD_NAMESPACE = "free_gift";
export const SHOP_METAFIELD_KEY = "config";

/**
 * Writes the given config JSON to the Shop's mirror metafield.
 *
 * @param {{ graphql: (query: string, options?: object) => Promise<Response> }} admin
 * @param {object} config - the same config object just saved to the discount node
 * @returns {Promise<{ success: true } | { success: false, message: string }>}
 */
export async function writeShopMetafieldMirror(admin, config) {
  const shopResponse = await admin.graphql(`
    query FreeGiftShopId {
      shop {
        id
      }
    }
  `);
  const shopJson = await shopResponse.json();
  const shopId = shopJson.data?.shop?.id;

  if (!shopId) {
    return { success: false, message: "Could not resolve the shop id for the metafield mirror." };
  }

  const response = await admin.graphql(
    `
      mutation SetFreeGiftShopMirror($metafields: [MetafieldsSetInput!]!) {
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
            ownerId: shopId,
            namespace: SHOP_METAFIELD_NAMESPACE,
            key: SHOP_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(config),
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

  return { success: true };
}
