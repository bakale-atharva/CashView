/** The "YYYY-MM" bucket (UTC) that monthly usage counters are keyed by. */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
