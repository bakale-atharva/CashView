import { describe, expect, test } from "vitest";
import { DAY_MS } from "./dates";
import { occurrence, occurrenceAfter, occurrenceOnOrAfter } from "./recurrence";

const d = (y: number, m: number, day: number) => Date.UTC(y, m - 1, day);

describe("occurrence", () => {
  test("weekly steps exactly seven days", () => {
    const start = d(2026, 1, 5);
    expect([0, 1, 2, 10].map((k) => occurrence(start, "weekly", k))).toEqual([
      d(2026, 1, 5),
      d(2026, 1, 12),
      d(2026, 1, 19),
      d(2026, 3, 16),
    ]);
  });

  test("monthly keeps the day of the month", () => {
    expect([0, 1, 2, 11, 12].map((k) => occurrence(d(2026, 1, 15), "monthly", k))).toEqual([
      d(2026, 1, 15),
      d(2026, 2, 15),
      d(2026, 3, 15),
      d(2026, 12, 15),
      d(2027, 1, 15),
    ]);
  });

  test("a start on the 31st clamps to short months and returns to the 31st", () => {
    const start = d(2026, 1, 31);
    expect([0, 1, 2, 3, 4, 5].map((k) => occurrence(start, "monthly", k))).toEqual([
      d(2026, 1, 31),
      d(2026, 2, 28), // clamped
      d(2026, 3, 31), // back on the 31st: it does not drift to the 28th
      d(2026, 4, 30), // clamped
      d(2026, 5, 31),
      d(2026, 6, 30),
    ]);
  });

  test("leap years: the 29th of February", () => {
    expect(occurrence(d(2024, 1, 29), "monthly", 1)).toBe(d(2024, 2, 29));
    expect(occurrence(d(2025, 1, 29), "monthly", 1)).toBe(d(2025, 2, 28));
    expect(occurrence(d(2024, 2, 29), "yearly", 1)).toBe(d(2025, 2, 28));
    expect(occurrence(d(2024, 2, 29), "yearly", 4)).toBe(d(2028, 2, 29));
  });

  test("quarterly steps three months", () => {
    expect([0, 1, 2, 3, 4].map((k) => occurrence(d(2026, 1, 31), "quarterly", k))).toEqual([
      d(2026, 1, 31),
      d(2026, 4, 30),
      d(2026, 7, 31),
      d(2026, 10, 31),
      d(2027, 1, 31),
    ]);
  });

  test("yearly steps a year", () => {
    expect(occurrence(d(2026, 6, 10), "yearly", 3)).toBe(d(2029, 6, 10));
  });

  test("snaps a start with a time of day to UTC midnight", () => {
    expect(occurrence(Date.UTC(2026, 0, 5, 17, 45), "weekly", 0)).toBe(d(2026, 1, 5));
  });
});

describe("occurrenceAfter", () => {
  test("is strictly after: an occurrence on the given day is not returned", () => {
    expect(occurrenceAfter(d(2026, 1, 15), "monthly", d(2026, 2, 15))).toBe(d(2026, 3, 15));
    expect(occurrenceAfter(d(2026, 1, 15), "monthly", d(2026, 2, 14))).toBe(d(2026, 2, 15));
    expect(occurrenceAfter(d(2026, 1, 15), "monthly", d(2026, 2, 16))).toBe(d(2026, 3, 15));
  });

  test("before the start, the first occurrence is the start itself", () => {
    expect(occurrenceAfter(d(2026, 6, 1), "monthly", d(2020, 1, 1))).toBe(d(2026, 6, 1));
  });

  test("skips any number of missed periods rather than backfilling", () => {
    // Weekly since 2020, asked for after a date years later.
    const next = occurrenceAfter(d(2020, 1, 6), "weekly", d(2026, 9, 21));
    expect(next).toBeGreaterThan(d(2026, 9, 21));
    expect(next - d(2026, 9, 21)).toBeLessThanOrEqual(7 * DAY_MS);
    expect((next - d(2020, 1, 6)) % (7 * DAY_MS)).toBe(0);
  });

  test("respects month-end clamping when stepping past it", () => {
    expect(occurrenceAfter(d(2026, 1, 31), "monthly", d(2026, 2, 1))).toBe(d(2026, 2, 28));
    expect(occurrenceAfter(d(2026, 1, 31), "monthly", d(2026, 2, 28))).toBe(d(2026, 3, 31));
  });

  test("agrees with counting occurrences one by one, for every frequency", () => {
    for (const frequency of ["weekly", "monthly", "quarterly", "yearly"] as const) {
      const start = d(2023, 1, 31);
      for (let dayOffset = -30; dayOffset < 900; dayOffset += 13) {
        const after = start + dayOffset * DAY_MS;
        let k = 0;
        while (occurrence(start, frequency, k) <= after) k++;
        expect(occurrenceAfter(start, frequency, after)).toBe(occurrence(start, frequency, k));
      }
    }
  });
});

test("occurrenceOnOrAfter includes the day itself", () => {
  expect(occurrenceOnOrAfter(d(2026, 1, 15), "monthly", d(2026, 2, 15))).toBe(d(2026, 2, 15));
  expect(occurrenceOnOrAfter(d(2026, 1, 15), "monthly", d(2026, 2, 16))).toBe(d(2026, 3, 15));
});
