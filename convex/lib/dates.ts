export const DAY_MS = 86_400_000;

/** Date-only fields hold UTC midnight of their day. */
export const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
