import { describe, expect, test } from "vitest";
import { DAY_MS } from "./dates";
import { MAX_CATEGORIES, normalizeCategoryName, normalizeExpenseInput } from "./expenseInput";
import { MAX_RECEIPT_BYTES, receiptProblem } from "./receipts";

const NOW = Date.UTC(2026, 8, 21, 15);
const base = {
  vendor: "Acme Supplies",
  amountCents: 5000,
  spentAt: Date.UTC(2026, 8, 1, 13),
  paymentMethod: "card",
};
const invalid = (field: string) =>
  expect.objectContaining({ data: expect.objectContaining({ code: "INVALID_INPUT", field }) });

describe("normalizeExpenseInput", () => {
  test("trims, defaults, and snaps the date to UTC midnight", () => {
    expect(
      normalizeExpenseInput(
        { ...base, vendor: "  Acme  ", description: " Paper ", paymentMethod: " card ", currency: " gbp " },
        NOW,
      ),
    ).toEqual({
      vendor: "Acme",
      description: "Paper",
      amountCents: 5000,
      taxCents: 0,
      currency: "GBP",
      spentAt: Date.UTC(2026, 8, 1),
      paymentMethod: "card",
      isBillable: false,
    });
  });

  test("blank description and currency mean unset", () => {
    const out = normalizeExpenseInput({ ...base, description: "  ", currency: "" }, NOW);
    expect(out.description).toBeUndefined();
    expect(out.currency).toBeUndefined();
  });

  test.each([0, -1, 10.5, Number.NaN, 1e12 + 1])("amount %j is refused", (amountCents) => {
    expect(() => normalizeExpenseInput({ ...base, amountCents }, NOW)).toThrow(invalid("amountCents"));
  });

  test("tax is a whole-cent part of the amount", () => {
    expect(normalizeExpenseInput({ ...base, taxCents: 500 }, NOW).taxCents).toBe(500);
    expect(normalizeExpenseInput({ ...base, taxCents: 5000 }, NOW).taxCents).toBe(5000);
    for (const taxCents of [-1, 1.5, 5001]) {
      expect(() => normalizeExpenseInput({ ...base, taxCents }, NOW)).toThrow(invalid("taxCents"));
    }
  });

  test("a date in the future is refused, up to a day of slack", () => {
    expect(() => normalizeExpenseInput({ ...base, spentAt: NOW + 2 * DAY_MS }, NOW)).toThrow(
      invalid("spentAt"),
    );
    expect(normalizeExpenseInput({ ...base, spentAt: NOW + DAY_MS / 2 }, NOW).spentAt).toBeGreaterThan(0);
    for (const spentAt of [Number.NaN, -1, Infinity]) {
      expect(() => normalizeExpenseInput({ ...base, spentAt }, NOW)).toThrow(invalid("spentAt"));
    }
  });

  test.each(["US", "USDX", "12A", "€"])("currency %j is refused", (currency) => {
    expect(() => normalizeExpenseInput({ ...base, currency }, NOW)).toThrow(invalid("currency"));
  });

  test("billable needs a client", () => {
    expect(() => normalizeExpenseInput({ ...base, isBillable: true }, NOW)).toThrow(invalid("clientId"));
    expect(normalizeExpenseInput({ ...base, isBillable: true, clientId: "c1" }, NOW).isBillable).toBe(true);
    // A client without billing it is fine.
    expect(normalizeExpenseInput({ ...base, clientId: "c1" }, NOW).isBillable).toBe(false);
  });

  test("vendor and payment method are required and bounded", () => {
    expect(() => normalizeExpenseInput({ ...base, vendor: "  " }, NOW)).toThrow(invalid("vendor"));
    expect(() => normalizeExpenseInput({ ...base, vendor: "x".repeat(201) }, NOW)).toThrow(invalid("vendor"));
    expect(() => normalizeExpenseInput({ ...base, paymentMethod: "" }, NOW)).toThrow(invalid("paymentMethod"));
    expect(() => normalizeExpenseInput({ ...base, description: "x".repeat(1001) }, NOW)).toThrow(
      invalid("description"),
    );
  });
});

test("normalizeCategoryName trims and bounds", () => {
  expect(normalizeCategoryName("  Coffee  ")).toBe("Coffee");
  expect(() => normalizeCategoryName("   ")).toThrow(invalid("name"));
  expect(() => normalizeCategoryName("x".repeat(61))).toThrow(invalid("name"));
  expect(MAX_CATEGORIES).toBe(100);
});

describe("receiptProblem", () => {
  test.each(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf", "IMAGE/PNG", "image/png; charset=x"])(
    "%s is accepted",
    (contentType) => {
      expect(receiptProblem({ contentType, size: 1000 })).toBeNull();
    },
  );

  test.each(["text/plain", "application/zip", "image/svg+xml", "text/html", "", undefined])(
    "%j is rejected",
    (contentType) => {
      expect(receiptProblem({ contentType, size: 1000 })).toMatch(/JPG, PNG/);
    },
  );

  test("the size limit is 10 MB, and empty files are rejected", () => {
    expect(receiptProblem({ contentType: "image/png", size: MAX_RECEIPT_BYTES })).toBeNull();
    expect(receiptProblem({ contentType: "image/png", size: MAX_RECEIPT_BYTES + 1 })).toMatch(/10 MB/);
    expect(receiptProblem({ contentType: "image/png", size: 0 })).toMatch(/10 MB/);
  });
});
