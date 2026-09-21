import { v } from "convex/values";
import type { Infer } from "convex/values";
import { literals } from "convex-helpers/validators";

/** "org" when a Clerk organization is active, "user" for personal scope. */
export const vScopeKind = literals("org", "user");

/** Capability roles. Clerk role slugs are normalized onto these in lib/scope.ts. */
export const vRole = literals("owner", "admin", "accountant", "viewer");

export const vPlanKey = literals("free", "pro", "business");

export const vUsageMetric = literals("clients", "invoices");

export const vInvoiceStatus = literals(
  "draft",
  "sent",
  "viewed",
  "paid",
  "overdue",
  "void",
);

export const vRecurringFrequency = literals(
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
);

export const vOcrStatus = literals("none", "pending", "done", "failed");

export const vAuditAction = literals("create", "update", "delete");

/** A postal address: a business's own, or a client's billing address. */
export const vAddress = v.object({
  line1: v.string(),
  line2: v.optional(v.string()),
  city: v.string(),
  region: v.optional(v.string()),
  postalCode: v.optional(v.string()),
  country: v.string(),
});

/** The resolved tenant + actor. Produced by requireScope(), never sent by clients. */
export const vScope = v.object({
  scopeId: v.string(),
  scopeKind: vScopeKind,
  userId: v.string(),
  role: vRole,
});

export type ScopeKind = Infer<typeof vScopeKind>;
export type Role = Infer<typeof vRole>;
export type PlanKey = Infer<typeof vPlanKey>;
export type UsageMetric = Infer<typeof vUsageMetric>;
export type InvoiceStatus = Infer<typeof vInvoiceStatus>;
export type Scope = Infer<typeof vScope>;
