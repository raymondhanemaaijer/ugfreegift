#!/usr/bin/env node
/**
 * One-off, re-runnable script to seed (or update) the checkout-block-validation
 * function's blocklist metafield.
 *
 * Why this exists as a standalone script, and not the Admin GraphiQL app:
 * `$app:`-reserved metafield namespaces (like `$app:checkout-block`, used
 * here) are only writable by the owning app itself. A write from the Admin
 * GraphiQL app, or any other app, is rejected. This script authenticates
 * as this app's own offline session — the same session the running admin
 * app uses via `authenticate.admin` — using `unauthenticated.admin(shop)`,
 * which reads that offline token straight from session storage instead of
 * going through an HTTP request/callback.
 *
 * Prerequisites (see the deploy handover for the full sequence):
 *   1. `shopify app deploy` has shipped the checkout-block-validation
 *      extension.
 *   2. Raymond has activated the rule in Admin > Settings > Checkout >
 *      Checkout rules. Only then does the Validation resource this script
 *      writes to actually exist.
 *   3. The app has been installed/re-authorized on the shop (so an offline
 *      session exists in session storage), and this process has the same
 *      environment variables the running app has — SHOPIFY_API_KEY,
 *      SHOPIFY_API_SECRET, SCOPES, SHOPIFY_APP_URL, POSTGRES_URL (pull
 *      these with `vercel env pull` if running locally against the
 *      deployed app's Postgres).
 *
 * Usage:
 *   SHOP=ultimate-gainz.myshopify.com \
 *     node scripts/seed-checkout-blocklist.mjs path/to/blocklist.json
 *
 * The blocklist JSON file is a plain array of { zip, phoneSuffix } pairs,
 * e.g.:
 *   [ { "zip": "28922", "phoneSuffix": "652129240" } ]
 *
 * To add a future repeat offender, edit that file and re-run this script —
 * no code change required.
 *
 * After writing, this script immediately reads the same metafield back and
 * prints it, so a failed or misdirected write is caught right here instead
 * of being silently swallowed by the function's fail-open empty-list
 * fallback (a metafield that didn't actually get written just means nobody
 * on the new list gets blocked, with no error at checkout).
 */

import fs from "node:fs";
import path from "node:path";

import { unauthenticated } from "../app/shopify.server.js";
import {
  findCheckoutBlockValidationNode,
  CHECKOUT_BLOCK_METAFIELD_NAMESPACE,
  CHECKOUT_BLOCK_METAFIELD_KEY,
} from "../app/lib/checkout-validation.server.js";
import { isValidBlocklist } from "../extensions/checkout-block-validation/src/resolve-blocklist.js";

function fail(message) {
  console.error(`\nError: ${message}\n`);
  process.exit(1);
}

async function main() {
  const shop = process.env.SHOP;
  if (!shop) {
    fail(
      "Set SHOP to the shop's *.myshopify.com domain, e.g.\n" +
        "  SHOP=ultimate-gainz.myshopify.com node scripts/seed-checkout-blocklist.mjs <path-to-blocklist.json>"
    );
  }

  const filePathArg = process.argv[2];
  if (!filePathArg) {
    fail("Usage: node scripts/seed-checkout-blocklist.mjs <path-to-blocklist.json>");
  }

  const filePath = path.resolve(process.cwd(), filePathArg);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`Could not read ${filePath}: ${error.message}`);
  }

  let blocklist;
  try {
    blocklist = JSON.parse(raw);
  } catch (error) {
    fail(`${filePath} is not valid JSON: ${error.message}`);
  }

  if (!isValidBlocklist(blocklist)) {
    fail(
      `${filePath} is not a valid blocklist. Expected an array of ` +
        `{ "zip": "<string>", "phoneSuffix": "<string>" } objects, e.g.\n` +
        `  [ { "zip": "28922", "phoneSuffix": "652129240" } ]`
    );
  }

  console.log(`Authenticating as the app's offline session for ${shop} ...`);
  const { admin } = await unauthenticated.admin(shop);

  console.log("Looking up the checkout-block-validation Validation resource ...");
  const validationNode = await findCheckoutBlockValidationNode(admin);

  if (!validationNode) {
    fail(
      "No checkout-block-validation Validation resource found. Deploy the " +
        "extension (`shopify app deploy`) and activate the rule in Admin > " +
        "Settings > Checkout > Checkout rules before running this script."
    );
  }

  console.log(`Found Validation ${validationNode.id} (enabled: ${validationNode.enabled}).`);
  console.log(`Writing ${blocklist.length} entr${blocklist.length === 1 ? "y" : "ies"} to ${CHECKOUT_BLOCK_METAFIELD_NAMESPACE}/${CHECKOUT_BLOCK_METAFIELD_KEY} ...`);

  const setResponse = await admin.graphql(
    `
      mutation SeedCheckoutBlocklist($metafields: [MetafieldsSetInput!]!) {
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
            ownerId: validationNode.id,
            namespace: CHECKOUT_BLOCK_METAFIELD_NAMESPACE,
            key: CHECKOUT_BLOCK_METAFIELD_KEY,
            type: "json",
            value: JSON.stringify(blocklist),
          },
        ],
      },
    }
  );
  const setJson = await setResponse.json();
  const userErrors = setJson.data?.metafieldsSet?.userErrors ?? [];

  if (userErrors.length) {
    fail(
      `metafieldsSet returned user errors:\n` +
        userErrors.map((error) => `  - ${error.field?.join(".") ?? "(no field)"}: ${error.message}`).join("\n")
    );
  }

  console.log("Write reported success. Reading the metafield back to verify ...");

  // Mandatory read-back: re-query the same metafield directly, independent
  // of the write path above, so a failed or misdirected write can't be
  // silently masked by the function's fail-open fallback.
  const readBackNode = await findCheckoutBlockValidationNode(admin);
  const readBackValue = readBackNode?.metafieldJsonValue ?? null;

  console.log("\nRead-back value:");
  console.log(JSON.stringify(readBackValue, null, 2));

  const matches = JSON.stringify(readBackValue) === JSON.stringify(blocklist);

  if (!matches) {
    fail(
      "Read-back value does NOT match what was written. Do not assume the " +
        "blocklist is active — investigate before relying on this rule."
    );
  }

  console.log("\nRead-back matches the intended blocklist. Seed complete.");
}

main().catch((error) => {
  fail(error.stack ?? String(error));
});
