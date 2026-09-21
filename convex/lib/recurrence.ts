import type { Infer } from "convex/values";
import { DAY_MS, startOfUtcDay } from "./dates";
import type { vRecurringFrequency } from "./validators";

export type Frequency = Infer<typeof vRecurringFrequency>;

/**
 * The schedule of a recurring invoice: the k-th occurrence counted from its
 * start date. Every occurrence is computed from the start date, never from the
 * previous one, so a template that starts on the 31st runs on the 31st of every
 * month that has one and on the last day of those that do not (Feb 28 or 29),
 * and lands back on the 31st afterwards instead of drifting to the 28th.
 */
export function occurrence(start: number, frequency: Frequency, k: number): number {
  const origin = startOfUtcDay(start);
  if (frequency === "weekly") return origin + k * 7 * DAY_MS;

  const monthsPerStep = frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12;
  const first = new Date(origin);
  const day = first.getUTCDate();
  const months = first.getUTCMonth() + monthsPerStep * k;
  const year = first.getUTCFullYear() + Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(day, lastDay));
}

const APPROX_STEP_MS: Record<Frequency, number> = {
  weekly: 7 * DAY_MS,
  monthly: 30.44 * DAY_MS,
  quarterly: 91.31 * DAY_MS,
  yearly: 365.25 * DAY_MS,
};

/** The first occurrence strictly after `after`. */
export function occurrenceAfter(start: number, frequency: Frequency, after: number): number {
  // Start close to the answer, then step: exact whatever the month lengths.
  let k = Math.max(0, Math.floor((after - startOfUtcDay(start)) / APPROX_STEP_MS[frequency]) - 1);
  while (occurrence(start, frequency, k) <= after) k++;
  return occurrence(start, frequency, k);
}

/** The first occurrence on or after `from`. */
export function occurrenceOnOrAfter(start: number, frequency: Frequency, from: number): number {
  return occurrenceAfter(start, frequency, from - 1);
}
