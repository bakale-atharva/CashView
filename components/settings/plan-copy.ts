import type { Feature } from "@/convex/lib/entitlements";
import type { PlanKey } from "@/convex/lib/validators";

export const PLAN_LABEL: Record<PlanKey, string> = {
  free: "Free",
  pro: "Pro",
  business: "Business",
};

/**
 * The plan-gated features, in upgrade order, with the plan that unlocks each.
 * Mirrors PLAN_LIMITS in convex/lib/entitlements.ts; the core features every
 * plan carries (invoices, expenses, clients…) aren't listed.
 */
export const GATED_FEATURES: { feature: Feature; label: string; plan: PlanKey }[] = [
  { feature: "reports", label: "Reports & dashboard trends", plan: "pro" },
  { feature: "recurring_invoices", label: "Recurring invoices", plan: "pro" },
  { feature: "receipt_scanning", label: "Receipt scanning", plan: "business" },
  { feature: "multi_currency", label: "Multi-currency invoicing", plan: "business" },
];
