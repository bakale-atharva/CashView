import { ConvexError } from "convex/values";
import type { DatabaseReader } from "../_generated/server";
import { monthOf } from "./period";
import type { PlanKey, Scope, UsageMetric } from "./validators";

/**
 * What a scope's plan lets it do. The single source of truth: nothing else
 * hard-codes a limit or a feature list.
 *
 * Entitlements come from the `subscriptions` table that Clerk Billing
 * webhooks keep current, never from the JWT, and are enforced here on the
 * server. The UI only reflects them.
 */

// Ride on every plan, Free included. They exist so Clerk permissions such as
// `org:invoices:manage` resolve at all: a permission whose feature is missing
// from the payer's plan always reads false.
const CORE_FEATURES = ["invoices", "expenses", "clients", "settings", "audit"] as const;
const PREMIUM_FEATURES = [
  "reports",
  "recurring_invoices",
  "receipt_scanning",
  "multi_currency",
] as const;

export type Feature =
  | (typeof CORE_FEATURES)[number]
  | (typeof PREMIUM_FEATURES)[number];

type PlanLimits = {
  clients: number;
  invoicesPerMonth: number;
  orgSeats: number;
  features: readonly Feature[];
};

// Keyed by tier, not by payer type: `pro_org` and `pro_user` normalise to the
// same key, so every gate asks "what can this scope do", never "is this an
// organization". Only seats differ, and a personal workspace has exactly one.
export const PLAN_LIMITS = {
  free: {
    clients: 5,
    invoicesPerMonth: 10,
    orgSeats: 1,
    features: [...CORE_FEATURES],
  },
  pro: {
    clients: Infinity,
    invoicesPerMonth: Infinity,
    orgSeats: 5,
    features: [...CORE_FEATURES, "reports", "recurring_invoices"],
  },
  business: {
    clients: Infinity,
    invoicesPerMonth: Infinity,
    // 20, not Infinity: without Clerk's paid B2B Authentication add-on, Clerk
    // caps seats at 20, so its number is the one that actually binds. The UI
    // reads this value rather than printing the word "unlimited".
    orgSeats: 20,
    features: [...CORE_FEATURES, ...PREMIUM_FEATURES],
  },
} as const satisfies Record<PlanKey, PlanLimits>;

const PLAN_ORDER: readonly PlanKey[] = ["free", "pro", "business"];

/**
 * Statuses of a subscription item that still entitle the payer to its plan.
 *
 * - `active`: paid and current.
 * - `canceled`: the payer cancelled but has paid through the period, and
 *   Clerk sends `ended` when it actually runs out. Cutting access at the
 *   moment of cancelling would take away time they paid for.
 *
 * Everything else (`past_due`, `ended`, `expired`, `upcoming`, `incomplete`,
 * `abandoned`) does not: existing data stays readable, but the scope is held
 * to Free limits until the payment problem is resolved.
 */
const ENTITLED_STATUSES: ReadonlySet<string> = new Set(["active", "canceled"]);

export type Entitlements = {
  planKey: PlanKey;
  clients: number;
  invoicesPerMonth: number;
  seats: number;
  features: readonly Feature[];
};

export function entitlementsFor(
  planKey: PlanKey,
  scopeKind: Scope["scopeKind"],
): Entitlements {
  const plan: PlanLimits = PLAN_LIMITS[planKey];
  return {
    planKey,
    clients: plan.clients,
    invoicesPerMonth: plan.invoicesPerMonth,
    seats: scopeKind === "org" ? plan.orgSeats : 1,
    features: plan.features,
  };
}

/** The best plan among the entitled subscription items; Free when none. */
export function resolvePlanKey(
  rows: ReadonlyArray<{ planKey: PlanKey; status: string }>,
): PlanKey {
  let best: PlanKey = "free";
  for (const row of rows) {
    if (
      ENTITLED_STATUSES.has(row.status) &&
      PLAN_ORDER.indexOf(row.planKey) > PLAN_ORDER.indexOf(best)
    ) {
      best = row.planKey;
    }
  }
  return best;
}

type Ctx = { db: DatabaseReader; scope: Scope };

/**
 * Reads the scope's subscriptions. A scope with none, or none entitled,
 * resolves to Free, so a missing or stale sync can only ever fail closed.
 */
export async function getEntitlements(ctx: Ctx): Promise<Entitlements> {
  const rows = await ctx.db
    .query("subscriptions")
    .withIndex("by_scopeId", (q) => q.eq("scopeId", ctx.scope.scopeId))
    .take(50);
  return entitlementsFor(resolvePlanKey(rows), ctx.scope.scopeKind);
}

export function hasFeature(entitlements: Entitlements, feature: Feature): boolean {
  return entitlements.features.includes(feature);
}

/** What the UI turns into an upgrade prompt rather than a generic error toast. */
export type UpgradeRequired =
  | {
      code: "UPGRADE_REQUIRED";
      reason: "feature";
      feature: Feature;
      currentPlan: PlanKey;
      requiredPlan: PlanKey;
    }
  | {
      code: "UPGRADE_REQUIRED";
      reason: "quota";
      metric: UsageMetric;
      limit: number;
      used: number;
      currentPlan: PlanKey;
      requiredPlan: PlanKey;
    };

function lowestPlanWith(feature: Feature): PlanKey {
  return (
    PLAN_ORDER.find((plan) => PLAN_LIMITS[plan].features.some((f) => f === feature)) ??
    "business"
  );
}

/** Throws a typed UPGRADE_REQUIRED unless the scope's plan includes the feature. */
export async function requireFeature(ctx: Ctx, feature: Feature): Promise<Entitlements> {
  const entitlements = await getEntitlements(ctx);
  if (!hasFeature(entitlements, feature)) {
    throw new ConvexError<UpgradeRequired>({
      code: "UPGRADE_REQUIRED",
      reason: "feature",
      feature,
      currentPlan: entitlements.planKey,
      requiredPlan: lowestPlanWith(feature),
    });
  }
  return entitlements;
}

function limitFor(entitlements: Entitlements, metric: UsageMetric): number {
  return metric === "clients" ? entitlements.clients : entitlements.invoicesPerMonth;
}

/**
 * Refuses when creating one more would exceed the plan. Reads the counter and
 * never writes it: the triggers own the increment, so a new write path cannot
 * forget to count itself. Call it (or rely on the scoped writer, which calls
 * it for you) before the insert.
 *
 * `now` is the wall clock and is only meaningful in a mutation.
 */
export async function assertQuota(
  ctx: Ctx,
  metric: UsageMetric,
  now: number = Date.now(),
): Promise<void> {
  const entitlements = await getEntitlements(ctx);
  const limit = limitFor(entitlements, metric);
  if (limit === Infinity) return;

  const used = await getUsage(ctx, metric, now);
  if (used >= limit) {
    throw new ConvexError<UpgradeRequired>({
      code: "UPGRADE_REQUIRED",
      reason: "quota",
      metric,
      limit,
      used,
      currentPlan: entitlements.planKey,
      // Every paid plan lifts both quotas entirely.
      requiredPlan: "pro",
    });
  }
}

/** Current usage for a metric, for meters. `now` selects the month. */
export async function getUsage(
  ctx: Ctx,
  metric: UsageMetric,
  now: number,
): Promise<number> {
  const period = metric === "clients" ? "all" : monthOf(now);
  const counter = await ctx.db
    .query("usageCounters")
    .withIndex("by_scopeId_and_metric_and_period", (q) =>
      q.eq("scopeId", ctx.scope.scopeId).eq("metric", metric).eq("period", period),
    )
    .unique();
  return counter?.count ?? 0;
}
