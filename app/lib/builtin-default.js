/**
 * Admin-app copy of the extension's BUILTIN_DEFAULT_TIERS
 * (extensions/free-gift-discount/src/resolve-config.js), used to pre-fill
 * the Markets page's "Default" tiers the first time it loads with no
 * config metafield yet, so the UI shows the current live setup.
 *
 * Duplicated deliberately rather than imported across the app/<->extensions
 * boundary: vite.config.js's `server.fs.allow: ["app", "node_modules"]`
 * (this repo's dev server config) blocks the Vite dev server from serving
 * files outside `app/`, so a cross-import here would break `shopify app
 * dev`. Keep this in sync by hand with resolve-config.js's
 * BUILTIN_DEFAULT_TIERS if the live product/variant IDs ever change.
 */
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
