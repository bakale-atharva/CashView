import { ConvexError } from "convex/values";
import { literals } from "convex-helpers/validators";
import { DAY_MS, startOfUtcDay } from "./dates";
import { invalidInput } from "./errors";

/**
 * Pure helpers behind the reports: period bucketing, currency conversion,
 * receivables ageing. No I/O, so the parts that are easy to get subtly wrong
 * (period edges, rounding) are tested on their own.
 */

export type Granularity = "month" | "quarter" | "year";
export const vGranularity = literals("month", "quarter", "year");

/** No report reads more than this many rows from one table. */
export const REPORT_ROW_LIMIT = 10_000;
/** The most periods a series may contain (20 years of months). */
export const MAX_PERIODS = 240;

/** "2026-03", "2026-Q1" or "2026", by UTC calendar. */
export function periodKey(ms: number, granularity: Granularity): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  if (granularity === "year") return String(year);
  if (granularity === "quarter") return `${year}-Q${Math.floor(month / 3) + 1}`;
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

export type Period = { key: string; start: number };

/**
 * Every period that overlaps [from, to], in order, so a series has an entry
 * even for periods with no activity.
 */
export function periodRange(from: number, to: number, granularity: Granularity): Period[] {
  const first = new Date(from);
  const step = granularity === "year" ? 12 : granularity === "quarter" ? 3 : 1;
  let year = first.getUTCFullYear();
  let month =
    granularity === "year"
      ? 0
      : granularity === "quarter"
        ? Math.floor(first.getUTCMonth() / 3) * 3
        : first.getUTCMonth();

  const periods: Period[] = [];
  for (;;) {
    const start = Date.UTC(year, month, 1);
    if (start > to) break;
    periods.push({ key: periodKey(start, granularity), start });
    if (periods.length > MAX_PERIODS) break; // caller rejects; stops runaway loops
    month += step;
    year += Math.floor(month / 12);
    month %= 12;
  }
  return periods;
}

/**
 * Validates a report range and widens it to whole days: `from` becomes the
 * start of its day and `to` the last millisecond of its day, so a payment made
 * at 15:00 on the last day is inside the range. Throws INVALID_INPUT otherwise.
 */
export function normalizeRange(
  from: number,
  to: number,
  granularity: Granularity = "month",
): { from: number; to: number } {
  for (const [field, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw invalidInput(field, "Enter a valid date.");
  }
  const range = { from: startOfUtcDay(from), to: startOfUtcDay(to) + DAY_MS - 1 };
  if (range.to < range.from) throw invalidInput("to", "The end date cannot be before the start date.");
  if (periodRange(range.from, range.to, granularity).length > MAX_PERIODS) {
    throw invalidInput("to", "That range is too long. Choose 20 years or fewer.");
  }
  return range;
}

/** Converts cents to the base currency. A base-currency amount has no rate. */
export function convert(cents: number, rate: number | undefined): number {
  return Math.round(cents * (rate ?? 1));
}

/** Refuses a report that would read more than the limit, rather than under-count. */
export function assertWithinLimit(rowsRead: number, limit: number = REPORT_ROW_LIMIT): void {
  if (rowsRead > limit) {
    throw new ConvexError({
      code: "RANGE_TOO_LARGE",
      message: "There are too many records in that range. Choose a shorter one.",
    });
  }
}

export const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** How long an invoice has been past its due day, as of a day. */
export function agingBucket(dueDate: number, asOf: number): AgingBucket {
  const daysPastDue = Math.floor((startOfUtcDay(asOf) - dueDate) / DAY_MS);
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

/** A share of a total as a percentage with one decimal, or null when there is no total. */
export function percent(part: number, total: number): number | null {
  if (total === 0) return null;
  return Math.round((part / total) * 1000) / 10;
}
