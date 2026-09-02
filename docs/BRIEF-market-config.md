# Brief: per-market free gift configuration (admin UI + function config)

## Context (verified 2 Sep 2026)
- Repo: /Users/rhane/free-gift-discount (clone of github.com/Adriihey/free-gift-discount, 1 commit). Shopify app template (React Router 7, Polaris web components `<s-*>`, Prisma/Postgres sessions) + one Shopify Function extension `extensions/free-gift-discount` (JS, api_version 2026-04, targets cart.lines.discounts.generate.run and cart.delivery-options.discounts.generate.run).
- Production: app deployed on Vercel (https://free-gift-discount.vercel.app, config `shopify.app.free-gift-discount.toml`, client_id 4c20ac386ca510db542b0c74f304657f). Store: Ultimate Gainz (ultimate-gainz.com, EUR base). Automatic app discount already exists: node `gid://shopify/DiscountAutomaticNode/2273374470493`, title "Free Gift Discount", functionId 019e7523-7c65-7fee-980f-507ad3e4357a, ACTIVE, no metafields yet.
- Problem: all gift config is hardcoded in `extensions/free-gift-discount/src/cart_lines_discounts_generate_run.js`:
  - FREE_GIFT_IDS: socks (2 variants, "Performance Sokken" black/white), thong (4 variants S-XL "Seamless Thong Zwart"), shorts (4 variants XS-L "Luna Scrunch Short Zwart")
  - TIERS: socks 60, thong 80, shorts 110 (compared to non-gift subtotal in presentment currency)
  - Rule: a gift line gets 100% off only if exactly one line of that group is in cart (avoids stacking with Moonbundle). Non-gift subtotal excludes all gift variants.
- Admin UI today (`app/routes/app._index.jsx`): one button that creates the automatic discount (not idempotent). Nothing else.
- Store has 17 markets (Admin API `markets`): AU (AUD), Austria (EUR), Brazil (EUR), Canada (CAD), DA=Germany (EUR), europe (EUR, 29 countries), french (EUR), italy (EUR), Nederland (EUR, primary, handle is a uuid), NZ (NZD), Poland (PLN), ro (RON), singapore (SGD), Spain (EUR), Switzerland (CHF), UK (GBP), World (USD, 15 countries incl US).
- Function input schema facts: `Input.localization.country.isoCode` (CountryCode) is available; `Input.localization.market` is DEPRECATED (do not use). `Input.discount.metafield(namespace, key) { jsonValue }` is available. Cart line `cost.subtotalAmount.amount` is in presentment currency, so thresholds are naturally per-market currency.

## Goal
Raymond (store owner, non-developer for this repo) must be able to change, per market, (a) the threshold amounts and (b) which product variants are the free gifts, without code changes. A market may have different products than another market.

## Required design (decided, do not re-open)
1. Config lives in ONE JSON metafield on the discount node: namespace `$app:free-gift`, key `config`, type `json`. Written by the admin app via `metafieldsSet` (ownerId = discount node id). Read by the function via input query `discount { metafield(namespace: "$app:free-gift", key: "config") { jsonValue } }`.
2. Config shape (version 1):
   {
     "version": 1,
     "default": { "tiers": [ { "id": "socks", "label": "Socks", "threshold": 60, "variantIds": ["gid://shopify/ProductVariant/..."] }, ... ] },
     "markets": [ { "handle": "italy", "name": "italy", "currency": "EUR", "countryCodes": ["IT"], "enabled": true, "tiers": [ ... same shape ... ] } ]
   }
   Function resolution: find the market entry whose countryCodes includes `localization.country.isoCode` and enabled=true → use its tiers; otherwise use `default.tiers`. If the metafield is missing or invalid, fall back to the current hardcoded values (keep them as BUILTIN_DEFAULT) so production never breaks during rollout.
3. Function logic stays the same per tier (exactly-one-gift-line rule, 100% off, non-gift subtotal excludes ALL gift variants across ALL tiers of the resolved config). Add `localization { country { isoCode } }` to the input query. Do not touch the delivery-options function.
4. Admin UI (embedded app, keep Polaris web components `<s-*>` and React Router loader/action pattern already in the repo, English UI):
   - Home page `/app`: status card (discount found / active / missing → button that creates it, idempotent: check `automaticDiscountNodes(query:"type:app")` for our function first; find function via `shopifyFunctions` matching title "free-gift-discount").
   - Market config page: left column list "Default (all other markets)" + every enabled Shopify market from the Admin API `markets` query (name, currency, country codes). Selecting a market shows its tiers. A market either "Uses default" or "Custom" (toggle). Custom shows an editable tier table: label, threshold (number, currency shown), gift variants (list with product title + variant title + remove), "Add products" button using App Bridge `shopify.resourcePicker({ type: "product", multiple: true, filter: { variants: true } })` which returns selected variants; "Add tier", "Remove tier", "Copy from default".
   - Save button writes the whole config via `metafieldsSet`. Show toast on success/error. Unsaved-changes indicator via App Bridge save bar (`<s-save-bar>` or `shopify.saveBar`) if straightforward, otherwise a plain Save button is acceptable.
   - Variant titles for display: resolve variantIds with `nodes(ids:[...])` in the loader (product.title, variant title, price, image if cheap). Store only IDs in the config, never titles.
   - First load with no metafield: pre-fill default tiers from BUILTIN_DEFAULT so the UI shows the current live setup.
5. Scopes: add `read_markets` to `[access_scopes]` in BOTH toml files (needed for the `markets` query). Keep existing scopes.
6. Tests: update `extensions/free-gift-discount/tests/fixtures/*.json` so inputs include `localization.country.isoCode` and `discount.metafield` (null in the existing fixtures → builtin fallback keeps their expected outputs). Add at least: (a) metafield config with a market override for IT that has a different variant and lower threshold, cart from IT → override applies; (b) same config, cart from NL → default applies; (c) market override disabled → default applies. Run `npm test` inside the extension (vitest via @shopify/shopify-function-test-helpers, needs `shopify app function build`; if the build toolchain is unavailable in this environment, unit-test the pure resolution logic with plain vitest and say so).
7. Clean up: remove template leftovers in `shopify.app.toml` (demo metafield/metaobject definitions, `app.additional.jsx` link/page can go). Nav: Home, Markets.

## Non-goals
- No new database tables. No Moonbundle changes. No theme changes. No deploy (Raymond deploys with `shopify app deploy` + Vercel once he has access to the Partner app and Vercel project).

## Definition of done
- `npm run build` succeeds at repo root; `npm run lint` clean or only pre-existing warnings.
- Function tests pass (or pure-logic tests pass with a note on why the wasm build was skipped).
- README section "Configuring free gifts per market" explaining the metafield, fallback, and deploy steps (scope change → `shopify app deploy`, then reinstall/accept scopes in admin).
