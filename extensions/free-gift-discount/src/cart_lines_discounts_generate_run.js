import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
} from "../generated/api";
import { resolveConfig } from "./resolve-config";

/**
 * @typedef {import("../generated/api").CartInput} RunInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * @param {RunInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) {
    return { operations: [] };
  }

  const hasProductDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Product
  );

  if (!hasProductDiscountClass) {
    return { operations: [] };
  }

  const tiers = resolveConfig({
    metafieldJsonValue: input.discount.metafield?.jsonValue ?? null,
    countryIsoCode: input.localization?.country?.isoCode,
  });

  const allGiftIds = tiers.flatMap((tier) => tier.variantIds);

  let nonGiftSubtotal = 0;

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    const variantId = line.merchandise.id;

    if (!allGiftIds.includes(variantId)) {
      nonGiftSubtotal += Number(line.cost.subtotalAmount.amount);
    }
  }

  const candidates = [];

  for (const tier of tiers) {
    if (nonGiftSubtotal < tier.threshold) continue;

    const matchingGiftLines = input.cart.lines.filter((line) => {
      if (line.merchandise.__typename !== "ProductVariant") return false;

      return tier.variantIds.includes(line.merchandise.id);
    });

    // If there is more than one gift from the same group,
    // do not apply our app discount to avoid stacking with Moonbundle.
    if (matchingGiftLines.length !== 1) continue;

    const giftLine = matchingGiftLines[0];

    candidates.push({
      message: "Free gift",
      targets: [
        {
          cartLine: {
            id: giftLine.id,
            quantity: 1,
          },
        },
      ],
      value: {
        percentage: {
          value: 100,
        },
      },
    });
  }

  if (!candidates.length) {
    return { operations: [] };
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}