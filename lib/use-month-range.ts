import { useMemo } from "react";

/**
 * From the first of the month `months - 1` months ago (local time) to now.
 * Memoized on `months`, so query args stay stable across renders.
 */
export function useMonthRange(months: number): { from: number; to: number } {
  return useMemo(() => {
    const now = new Date();
    return {
      from: new Date(now.getFullYear(), now.getMonth() - (months - 1), 1).getTime(),
      to: now.getTime(),
    };
  }, [months]);
}
