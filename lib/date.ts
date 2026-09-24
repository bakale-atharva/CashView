/**
 * Dates from Convex are UTC-midnight milliseconds (convex/lib/dates.ts).
 * These helpers only format them for display and for `<input type="date">`.
 */

/** A date for display, in the viewer's locale. */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

/** UTC-midnight ms → the `YYYY-MM-DD` value a date input expects. */
export function dateToInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A date input's `YYYY-MM-DD` value → UTC-midnight ms; blank means unset. */
export function inputToDate(value: string): number | undefined {
  if (!value) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
