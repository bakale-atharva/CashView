import { describe, expect, test } from "vitest";
import { DAY_MS, startOfUtcDay } from "./dates";
import { MAX_LINES, computeTotals, formatInvoiceNumber, resolveDates } from "./invoiceMath";

const line = (over: Partial<Parameters<typeof computeTotals>[0][number]> = {}) => ({
  description: "Work",
  quantity: 1,
  unitPriceCents: 1000,
  taxRatePct: 0,
  ...over,
});
const invalid = (field: string) =>
  expect.objectContaining({ data: expect.objectContaining({ code: "INVALID_INPUT", field }) });

describe("computeTotals", () => {
  test("amount, then per-line tax, then total", () => {
    const t = computeTotals([line({ quantity: 2, unitPriceCents: 1000, taxRatePct: 10 })]);
    expect(t.lines[0]).toMatchObject({ amountCents: 2000, taxCents: 200, position: 0 });
    expect(t).toMatchObject({ subtotalCents: 2000, taxCents: 200, discountCents: 0, totalCents: 2200 });
  });

  test("tax is computed per line, so each line rounds on its own", () => {
    // 3333 * 7.25% = 241.6425 -> 242, twice, not 483.285 -> 483.
    const t = computeTotals([
      line({ unitPriceCents: 3333, taxRatePct: 7.25 }),
      line({ unitPriceCents: 3333, taxRatePct: 7.25 }),
    ]);
    expect(t.lines.map((l) => l.taxCents)).toEqual([242, 242]);
    expect(t.taxCents).toBe(484);
  });

  test("lines can carry different rates", () => {
    const t = computeTotals([
      line({ unitPriceCents: 10_000, taxRatePct: 20 }),
      line({ unitPriceCents: 5_000, taxRatePct: 0 }),
    ]);
    expect(t).toMatchObject({ subtotalCents: 15_000, taxCents: 2_000, totalCents: 17_000 });
  });

  test("fractional quantities round half up to whole cents", () => {
    expect(computeTotals([line({ quantity: 1.5, unitPriceCents: 1999 })]).subtotalCents).toBe(
      2999,
    );
    // Floating point would give 114.99999999999999.
    expect(computeTotals([line({ quantity: 1.15, unitPriceCents: 100 })]).subtotalCents).toBe(
      115,
    );
  });

  test("a discount comes off after tax", () => {
    const t = computeTotals([line({ unitPriceCents: 10_000, taxRatePct: 10 })], 1_500);
    expect(t).toMatchObject({ subtotalCents: 10_000, taxCents: 1_000, discountCents: 1_500, totalCents: 9_500 });
  });

  test("a discount may equal the whole total but not exceed it", () => {
    expect(computeTotals([line({ unitPriceCents: 1000 })], 1000).totalCents).toBe(0);
    expect(() => computeTotals([line({ unitPriceCents: 1000 })], 1001)).toThrow(
      invalid("discountCents"),
    );
  });

  test.each([-1, 1.5, Number.NaN, Infinity])("discount %j is refused", (discount) => {
    expect(() => computeTotals([line()], discount)).toThrow(invalid("discountCents"));
  });

  test("trims descriptions", () => {
    expect(computeTotals([line({ description: "  Design  " })]).lines[0].description).toBe(
      "Design",
    );
  });

  test("needs 1 to 100 lines", () => {
    expect(() => computeTotals([])).toThrow(invalid("lineItems"));
    expect(() => computeTotals(Array.from({ length: MAX_LINES + 1 }, () => line()))).toThrow(
      invalid("lineItems"),
    );
    expect(computeTotals(Array.from({ length: MAX_LINES }, () => line())).lines).toHaveLength(
      MAX_LINES,
    );
  });

  test.each([
    ["description", { description: "  " }],
    ["description", { description: "x".repeat(501) }],
    ["quantity", { quantity: 0 }],
    ["quantity", { quantity: -2 }],
    ["quantity", { quantity: Number.NaN }],
    ["quantity", { quantity: 1e6 + 1 }],
    ["unitPriceCents", { unitPriceCents: -1 }],
    ["unitPriceCents", { unitPriceCents: 10.5 }],
    ["unitPriceCents", { unitPriceCents: 1e11, quantity: 100 }],
    ["taxRatePct", { taxRatePct: -1 }],
    ["taxRatePct", { taxRatePct: 100.01 }],
    ["taxRatePct", { taxRatePct: 7.255 }],
    ["taxRatePct", { taxRatePct: Number.NaN }],
  ])("a bad line %s is refused, naming the line and field", (field, over) => {
    expect(() => computeTotals([line(), line(over)])).toThrow(invalid(`lineItems.1.${field}`));
  });

  test("a tax rate of exactly 0 and 100 is fine", () => {
    expect(computeTotals([line({ taxRatePct: 0 })]).taxCents).toBe(0);
    expect(computeTotals([line({ taxRatePct: 100 })]).taxCents).toBe(1000);
  });
});

describe("resolveDates", () => {
  const NOW = Date.UTC(2026, 8, 21, 15, 30); // 21 Sep 2026, mid-afternoon

  test("defaults to today and the payment terms", () => {
    const d = resolveDates({}, 30, NOW);
    expect(d.issueDate).toBe(Date.UTC(2026, 8, 21));
    expect(d.dueDate).toBe(Date.UTC(2026, 8, 21) + 30 * DAY_MS);
  });

  test("snaps explicit dates to UTC midnight", () => {
    const d = resolveDates(
      { issueDate: Date.UTC(2026, 0, 5, 13), dueDate: Date.UTC(2026, 0, 20, 23, 59) },
      30,
      NOW,
    );
    expect(d).toEqual({ issueDate: Date.UTC(2026, 0, 5), dueDate: Date.UTC(2026, 0, 20) });
  });

  test("terms count from the issue date, not from today", () => {
    const d = resolveDates({ issueDate: Date.UTC(2026, 0, 1) }, 14, NOW);
    expect(d.dueDate).toBe(Date.UTC(2026, 0, 15));
  });

  test("a due date before the issue date is refused", () => {
    expect(() =>
      resolveDates({ issueDate: Date.UTC(2026, 5, 2), dueDate: Date.UTC(2026, 5, 1) }, 30, NOW),
    ).toThrow(invalid("dueDate"));
  });

  test("the same day is allowed", () => {
    const day = Date.UTC(2026, 5, 1);
    expect(resolveDates({ issueDate: day, dueDate: day }, 30, NOW).dueDate).toBe(day);
  });

  test.each([Number.NaN, -1, Infinity])("date %j is refused", (bad) => {
    expect(() => resolveDates({ issueDate: bad }, 30, NOW)).toThrow(invalid("issueDate"));
    expect(() => resolveDates({ dueDate: bad }, 30, NOW)).toThrow(invalid("dueDate"));
  });
});

test("startOfUtcDay", () => {
  expect(startOfUtcDay(Date.UTC(2026, 8, 21, 23, 59, 59))).toBe(Date.UTC(2026, 8, 21));
});

test.each([
  ["INV-", 1, "INV-0001"],
  ["INV-", 42, "INV-0042"],
  ["ACME/", 12345, "ACME/12345"],
  ["", 7, "0007"],
])("formatInvoiceNumber(%j, %i) = %s", (prefix, seq, expected) => {
  expect(formatInvoiceNumber(prefix, seq)).toBe(expected);
});
