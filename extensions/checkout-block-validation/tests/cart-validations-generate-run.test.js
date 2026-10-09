import { describe, test, expect } from "vitest";
import { cartValidationsGenerateRun } from "../src/cart_validations_generate_run";

const BLOCK_MESSAGE =
  "This order cannot be completed. Please contact help@ultimate-gainz.com.";

const blocklist = [{ zip: "28922", phoneSuffix: "652129240" }];

/**
 * @param {object} [overrides]
 */
function buildInput(overrides = {}) {
  return {
    cart: {
      buyerIdentity: {
        phone: null,
        customer: {
          id: "gid://shopify/Customer/1",
          hasAnyTag: false,
        },
      },
      deliveryGroups: [],
    },
    validation: {
      metafield: null,
    },
    ...overrides,
  };
}

describe("cartValidationsGenerateRun", () => {
  test("customer with tag 'blocked' is blocked", () => {
    const input = buildInput({
      cart: {
        buyerIdentity: {
          phone: null,
          customer: { id: "gid://shopify/Customer/28452876190045", hasAnyTag: true },
        },
        deliveryGroups: [],
      },
    });

    const result = cartValidationsGenerateRun(input);

    expect(result.operations).toEqual([
      {
        validationAdd: {
          errors: [{ message: BLOCK_MESSAGE, target: "$.cart" }],
        },
      },
    ]);
  });

  test("matching postal code plus phone is blocked", () => {
    const input = buildInput({
      cart: {
        buyerIdentity: {
          phone: "+34652129240",
          customer: { id: "gid://shopify/Customer/2", hasAnyTag: false },
        },
        deliveryGroups: [
          { deliveryAddress: { zip: "28922", phone: null } },
        ],
      },
      validation: {
        metafield: { jsonValue: blocklist },
      },
    });

    const result = cartValidationsGenerateRun(input);

    expect(result.operations).toEqual([
      {
        validationAdd: {
          errors: [{ message: BLOCK_MESSAGE, target: "$.cart" }],
        },
      },
    ]);
  });

  test("matching postal code plus phone on the delivery address (not buyer phone) is blocked", () => {
    const input = buildInput({
      cart: {
        buyerIdentity: { phone: null, customer: null },
        deliveryGroups: [
          { deliveryAddress: { zip: "28922", phone: "+34652129240" } },
        ],
      },
      validation: {
        metafield: { jsonValue: blocklist },
      },
    });

    const result = cartValidationsGenerateRun(input);

    expect(result.operations).toEqual([
      {
        validationAdd: {
          errors: [{ message: BLOCK_MESSAGE, target: "$.cart" }],
        },
      },
    ]);
  });

  test("matching postal code WITHOUT matching phone is NOT blocked", () => {
    const input = buildInput({
      cart: {
        buyerIdentity: {
          phone: "+34600000000",
          customer: { id: "gid://shopify/Customer/3", hasAnyTag: false },
        },
        deliveryGroups: [
          { deliveryAddress: { zip: "28922", phone: null } },
        ],
      },
      validation: {
        metafield: { jsonValue: blocklist },
      },
    });

    const result = cartValidationsGenerateRun(input);

    expect(result.operations).toEqual([]);
  });

  test("an ordinary customer is NOT blocked", () => {
    const input = buildInput({
      cart: {
        buyerIdentity: {
          phone: "+31612345678",
          customer: { id: "gid://shopify/Customer/4", hasAnyTag: false },
        },
        deliveryGroups: [
          { deliveryAddress: { zip: "1012AB", phone: "+31612345678" } },
        ],
      },
      validation: {
        metafield: { jsonValue: blocklist },
      },
    });

    const result = cartValidationsGenerateRun(input);

    expect(result.operations).toEqual([]);
  });

  test("missing metafield blocks nobody, even with a matching phone and zip", () => {
    const input = buildInput({
      cart: {
        buyerIdentity: {
          phone: "+34652129240",
          customer: { id: "gid://shopify/Customer/5", hasAnyTag: false },
        },
        deliveryGroups: [
          { deliveryAddress: { zip: "28922", phone: null } },
        ],
      },
      validation: {
        metafield: null,
      },
    });

    const result = cartValidationsGenerateRun(input);

    expect(result.operations).toEqual([]);
  });

  test("malformed metafield blocks nobody, even with a matching phone and zip", () => {
    const input = buildInput({
      cart: {
        buyerIdentity: {
          phone: "+34652129240",
          customer: { id: "gid://shopify/Customer/6", hasAnyTag: false },
        },
        deliveryGroups: [
          { deliveryAddress: { zip: "28922", phone: null } },
        ],
      },
      validation: {
        metafield: { jsonValue: { not: "an-array" } },
      },
    });

    const result = cartValidationsGenerateRun(input);

    expect(result.operations).toEqual([]);
  });

  test("guest checkout / missing customer does not crash and is not blocked", () => {
    const input = buildInput({
      cart: {
        buyerIdentity: { phone: null, customer: null },
        deliveryGroups: [],
      },
      validation: {
        metafield: { jsonValue: blocklist },
      },
    });

    expect(() => cartValidationsGenerateRun(input)).not.toThrow();
    expect(cartValidationsGenerateRun(input).operations).toEqual([]);
  });

  test("guest checkout (missing buyerIdentity entirely) does not crash", () => {
    const input = {
      cart: {
        buyerIdentity: null,
        deliveryGroups: [{ deliveryAddress: { zip: "1012AB", phone: "600000000" } }],
      },
      validation: {
        metafield: { jsonValue: blocklist },
      },
    };

    expect(() => cartValidationsGenerateRun(input)).not.toThrow();
    // Neither the zip nor the phone matches the blocklist entry — not blocked.
    expect(cartValidationsGenerateRun(input).operations).toEqual([]);
  });

  test("delivery group with a null delivery address does not crash", () => {
    const input = buildInput({
      cart: {
        buyerIdentity: {
          phone: "+34652129240",
          customer: { id: "gid://shopify/Customer/7", hasAnyTag: false },
        },
        deliveryGroups: [{ deliveryAddress: null }],
      },
      validation: {
        metafield: { jsonValue: blocklist },
      },
    });

    expect(() => cartValidationsGenerateRun(input)).not.toThrow();
    // No zip present anywhere, so no match even though the phone matches.
    expect(cartValidationsGenerateRun(input).operations).toEqual([]);
  });
});
