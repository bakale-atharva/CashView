import { ConvexError } from "convex/values";

/**
 * Turns a thrown Convex error into one line a toast can show. Every
 * mutation's typed errors (convex/lib/errors.ts, entitlements.ts) are
 * handled by name; anything else falls back to its message.
 */
export function describeError(error: unknown): string {
  if (error instanceof ConvexError) {
    const data = error.data as Record<string, unknown>;
    switch (data.code) {
      case "INVALID_INPUT":
        return typeof data.message === "string" ? data.message : "That value isn't valid.";
      case "UPGRADE_REQUIRED":
        return data.reason === "quota"
          ? `You've reached this plan's ${data.metric} limit. Upgrade to add more.`
          : `That's a ${typeof data.requiredPlan === "string" ? data.requiredPlan : "higher"}-plan feature.`;
      case "CONFLICT":
        if (data.reason === "client_has_records") {
          return "This client has invoices, payments, or expenses — archive it instead of deleting.";
        }
        if (data.reason === "client_currency_locked") {
          return "This client's currency can't change once they have invoices.";
        }
        return "That action conflicts with the current state.";
      case "FORBIDDEN":
        return "Your role doesn't allow that.";
      case "NOT_FOUND":
        return "That record couldn't be found.";
      default:
        break;
    }
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
