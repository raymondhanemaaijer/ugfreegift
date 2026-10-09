import {
  DeliveryDiscountSelectionStrategy,
  DiscountClass,
} from "../generated/api";
import { resolveConfig } from "./resolve-config";

/**
  * @typedef {import("../generated/api").DeliveryInput} RunInput
  * @typedef {import("../generated/api").CartDeliveryOptionsDiscountsGenerateRunResult} CartDeliveryOptionsDiscountsGenerateRunResult
  */

/**
  * Applies a 100%-off shipping discount to the cart's first delivery group
  * once the non-gift subtotal reaches the resolved market's free-shipping
  * threshold, mirroring `cart_lines_discounts_generate_run`'s per-market
  * config resolution so both functions always agree on what counts as a
  * "gift" line.
  *
  * This only ever runs once SHIPPING is enabled as a discount class on the
  * live discount (it is not today), and is intentionally threshold-gated so
  * turning that on later does not unconditionally give free shipping to every
  * order the way the current unconditional version did.
  *
  * @param {RunInput} input
  * @returns {CartDeliveryOptionsDiscountsGenerateRunResult}
  */
export function cartDeliveryOptionsDiscountsGenerateRun(input) {
  const firstDeliveryGroup = input.cart.deliveryGroups[0];
  if (!firstDeliveryGroup) {
    return { operations: [] };
  }

  const hasShippingDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Shipping,
  );

  if (!hasShippingDiscountClass) {
    return { operations: [] };
  }

  const { tiers, freeShipping } = resolveConfig({
    metafieldJsonValue: input.discount.metafield?.jsonValue ?? null,
    countryIsoCode: input.localization?.country?.isoCode,
  });

  if (!freeShipping.enabled) {
    return { operations: [] };
  }

  const allGiftIds = tiers.flatMap((tier) => tier.variantIds);

  let nonGiftSubtotal = 0;
  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    if (!allGiftIds.includes(line.merchandise.id)) {
      nonGiftSubtotal += Number(line.cost.subtotalAmount.amount);
    }
  }

  if (nonGiftSubtotal < freeShipping.threshold) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates: [
            {
              message: "FREE DELIVERY",
              targets: [
                {
                  deliveryGroup: {
                    id: firstDeliveryGroup.id,
                  },
                },
              ],
              value: {
                percentage: {
                  value: 100,
                },
              },
            },
          ],
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
