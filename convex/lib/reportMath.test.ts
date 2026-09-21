import { describe, expect, test } from "vitest";
import { DAY_MS } from "./dates";
import {
  MAX_PERIODS,
  REPORT_ROW_LIMIT,
  agingBucket,
  assertWithinLimit,
  convert,
  normalizeRange,
  percent,
  periodKey,
  periodRange,
} from "./reportMath";

const d = (y: number, m: number, day = 1, h = 0, min = 0, s = 0, ms = 0) =>
  Date.UTC(y, m - 1, day, h, min, s, ms);
const invalid = (field: string) =>
  expect.objectContaining({ data: expect.objectContaining({ code: "INVALID_INPUT", field }) });

describe("periodKey", () => {
  test("months follow the UTC calendar, to the millisecond", () => {
    expect(periodKey(d(2026, 1, 31, 23, 59, 59, 999), "month")).toBe("2026-01");
    expect(periodKey(d(2026, 2, 1), "month")).toBe("2026-02");
    expect(periodKey(d(2026, 12, 31, 23, 59, 59, 999), "month")).toBe("2026-12");
    expect(periodKey(d(2027, 1, 1), "month")).toBe("2027-01");
  });

  test.each([
    [d(2026, 1, 1), "2026-Q1"],
    [d(2026, 3, 31, 23, 59, 59, 999), "2026-Q1"],
    [d(2026, 4, 1), "2026-Q2"],
    [d(2026, 6, 30), "2026-Q2"],
    [d(2026, 7, 1), "2026-Q3"],
    [d(2026, 9, 30), "2026-Q3"],
    [d(2026, 10, 1), "2026-Q4"],
    [d(2026, 12, 31), "2026-Q4"],
  ])("quarters: %i is %s", (ms, key) => {
    expect(periodKey(ms, "quarter")).toBe(key);
  });

  test("years", () => {
    expect(periodKey(d(2026, 12, 31, 23, 59), "year")).toBe("2026");
    expect(periodKey(d(2027, 1, 1), "year")).toBe("2027");
  });
});

describe("periodRange", () => {
  test("lists every month, including quiet ones, across a year boundary", () => {
    const keys = periodRange(d(2025, 11, 15), d(2026, 2, 3), "month").map((p) => p.key);
    expect(keys).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  test("a period that only partly overlaps the range is included", () => {
    expect(periodRange(d(2026, 1, 31), d(2026, 2, 1), "month").map((p) => p.key)).toEqual([
      "2026-01",
      "2026-02",
    ]);
  });

  test("quarters and years", () => {
    expect(periodRange(d(2026, 2, 1), d(2026, 11, 1), "quarter").map((p) => p.key)).toEqual([
      "2026-Q1",
      "2026-Q2",
      "2026-Q3",
      "2026-Q4",
    ]);
    expect(periodRange(d(2024, 6, 1), d(2026, 1, 1), "year").map((p) => p.key)).toEqual([
      "2024",
      "2025",
      "2026",
    ]);
  });

  test("a single day is one period", () => {
    expect(periodRange(d(2026, 5, 10), d(2026, 5, 10), "month")).toEqual([
      { key: "2026-05", start: d(2026, 5, 1) },
    ]);
  });

  test("each period starts on the first of its unit", () => {
    const [q1, q2] = periodRange(d(2026, 2, 20), d(2026, 5, 1), "quarter");
    expect(q1.start).toBe(d(2026, 1, 1));
    expect(q2.start).toBe(d(2026, 4, 1));
  });

  test("a runaway range stops rather than looping", () => {
    expect(periodRange(0, d(9999, 1, 1), "month").length).toBeGreaterThan(MAX_PERIODS);
    expect(periodRange(0, d(9999, 1, 1), "month").length).toBeLessThan(MAX_PERIODS + 5);
  });
});

describe("normalizeRange", () => {
  test("starts `from` at the start of its day and `to` at the very end of its day", () => {
    expect(normalizeRange(d(2026, 1, 5, 14), d(2026, 1, 31, 9))).toEqual({
      from: d(2026, 1, 5),
      to: d(2026, 1, 31, 23, 59, 59, 999),
    });
  });

  test("a one-day range is that whole day", () => {
    const r = normalizeRange(d(2026, 3, 3), d(2026, 3, 3));
    expect(r.to - r.from).toBe(DAY_MS - 1);
  });

  test("the end cannot be before the start", () => {
    expect(() => normalizeRange(d(2026, 3, 2), d(2026, 3, 1))).toThrow(invalid("to"));
  });

  test.each([Number.NaN, -1, Infinity])("a date of %j is refused", (bad) => {
    expect(() => normalizeRange(bad, d(2026, 1, 1))).toThrow(invalid("from"));
    expect(() => normalizeRange(d(2026, 1, 1), bad)).toThrow(invalid("to"));
  });

  test("a series may have at most 240 periods", () => {
    // Exactly 20 years of months is the limit; one more month is refused.
    expect(() => normalizeRange(d(2001, 1, 1), d(2020, 12, 31), "month")).not.toThrow();
    expect(() => normalizeRange(d(2000, 12, 1), d(2020, 12, 31), "month")).toThrow(invalid("to"));
    // The same span grouped by year is only 20 periods.
    expect(() => normalizeRange(d(2000, 1, 1), d(2020, 12, 31), "year")).not.toThrow();
  });
});

describe("convert", () => {
  test("a base-currency amount is unchanged", () => {
    expect(convert(12345, undefined)).toBe(12345);
  });
  test("rounds to whole cents, half up", () => {
    expect(convert(1000, 1.1)).toBe(1100);
    expect(convert(333, 1.5)).toBe(500); // 499.5
    expect(convert(10, 0.0055)).toBe(0);
    expect(convert(1, 0.5)).toBe(1); // 0.5 rounds up
  });
  test("handles a rate below one (a stronger base currency)", () => {
    expect(convert(10_000, 0.85)).toBe(8_500);
  });
});

describe("assertWithinLimit", () => {
  test("reading exactly the limit is fine; one over is refused with a typed error", () => {
    expect(() => assertWithinLimit(REPORT_ROW_LIMIT)).not.toThrow();
    expect(() => assertWithinLimit(REPORT_ROW_LIMIT + 1)).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ code: "RANGE_TOO_LARGE" }) }),
    );
  });
  test("takes an explicit limit", () => {
    expect(() => assertWithinLimit(6, 5)).toThrow();
    expect(() => assertWithinLimit(5, 5)).not.toThrow();
  });
});

describe("agingBucket", () => {
  const asOf = d(2026, 9, 21, 15, 30);
  const due = (daysAgo: number) => d(2026, 9, 21) - daysAgo * DAY_MS;

  test.each([
    [-10, "current"], // due in the future
    [0, "current"], // due today
    [1, "1-30"],
    [30, "1-30"],
    [31, "31-60"],
    [60, "31-60"],
    [61, "61-90"],
    [90, "61-90"],
    [91, "90+"],
    [400, "90+"],
  ] as const)("%i days past due is %s", (daysAgo, bucket) => {
    expect(agingBucket(due(daysAgo), asOf)).toBe(bucket);
  });

  test("the time of day in asOf is ignored", () => {
    expect(agingBucket(due(0), d(2026, 9, 21, 23, 59))).toBe("current");
    expect(agingBucket(due(1), d(2026, 9, 21, 0, 0))).toBe("1-30");
  });
});

describe("percent", () => {
  test("one decimal place", () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(2, 3)).toBe(66.7);
    expect(percent(50, 200)).toBe(25);
    expect(percent(-5, 20)).toBe(-25);
  });
  test("no total means no percentage, not zero or NaN", () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(10, 0)).toBeNull();
  });
});
