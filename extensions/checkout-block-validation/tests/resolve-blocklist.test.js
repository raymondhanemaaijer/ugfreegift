import { describe, test, expect } from "vitest";
import { resolveBlocklist, isValidBlocklist } from "../src/resolve-blocklist";

// Plain-vitest tests against the pure resolution logic directly, with no
// @shopify/shopify-function-test-helpers and no wasm build required. Mirrors
// tests/resolve-config.test.js in the free-gift-discount extension.

const validEntry = { zip: "28922", phoneSuffix: "652129240" };

describe("isValidBlocklist", () => {
  test("accepts an array of valid entries", () => {
    expect(isValidBlocklist([validEntry])).toBe(true);
  });

  test("accepts an empty array", () => {
    expect(isValidBlocklist([])).toBe(true);
  });

  test("rejects a non-array value", () => {
    expect(isValidBlocklist({ zip: "28922", phoneSuffix: "652129240" })).toBe(false);
    expect(isValidBlocklist("not-an-array")).toBe(false);
    expect(isValidBlocklist(null)).toBe(false);
    expect(isValidBlocklist(undefined)).toBe(false);
  });

  test("rejects entries missing a field", () => {
    expect(isValidBlocklist([{ zip: "28922" }])).toBe(false);
    expect(isValidBlocklist([{ phoneSuffix: "652129240" }])).toBe(false);
  });

  test("rejects entries with wrong field types", () => {
    expect(isValidBlocklist([{ zip: 28922, phoneSuffix: "652129240" }])).toBe(false);
    expect(isValidBlocklist([{ zip: "28922", phoneSuffix: 652129240 }])).toBe(false);
  });

  test("rejects entries with empty string fields", () => {
    expect(isValidBlocklist([{ zip: "", phoneSuffix: "652129240" }])).toBe(false);
    expect(isValidBlocklist([{ zip: "28922", phoneSuffix: "" }])).toBe(false);
  });

  test("rejects a list where only one entry is malformed", () => {
    expect(isValidBlocklist([validEntry, { zip: "12345" }])).toBe(false);
  });
});

describe("resolveBlocklist", () => {
  test("valid list is returned as-is", () => {
    const list = [validEntry];
    expect(resolveBlocklist(list)).toBe(list);
  });

  test("valid list with multiple entries is returned as-is", () => {
    const list = [validEntry, { zip: "12345", phoneSuffix: "600000000" }];
    expect(resolveBlocklist(list)).toBe(list);
  });

  test("empty list resolves to an empty list", () => {
    expect(resolveBlocklist([])).toEqual([]);
  });

  test("missing metafield (null) resolves to an empty list", () => {
    expect(resolveBlocklist(null)).toEqual([]);
  });

  test("missing metafield (undefined) resolves to an empty list", () => {
    expect(resolveBlocklist(undefined)).toEqual([]);
  });

  test("non-array value resolves to an empty list", () => {
    expect(resolveBlocklist({ zip: "28922", phoneSuffix: "652129240" })).toEqual([]);
    expect(resolveBlocklist("garbage")).toEqual([]);
    expect(resolveBlocklist(42)).toEqual([]);
  });

  test("array with an entry missing a field resolves to an empty list", () => {
    expect(resolveBlocklist([{ zip: "28922" }])).toEqual([]);
  });

  test("array with an entry of the wrong type resolves to an empty list", () => {
    expect(resolveBlocklist([{ zip: 28922, phoneSuffix: "652129240" }])).toEqual([]);
  });
});
