// Test-only functions that exercise the scoped builders in lib/functions.ts.
//
// Not deployed: the Convex bundler skips any file whose name contains more
// than one dot, so these never exist on a real deployment. They are reached
// from tests through makeFunctionReference, not the generated `api`.
import { v } from "convex/values";
import { literals } from "convex-helpers/validators";
import { requireFeature } from "./lib/entitlements";
import {
  getInScope,
  internalScopedMutation,
  orgOnlyMutation,
  scopedMutation,
  scopedQuery,
} from "./lib/functions";
import { requireCapability } from "./lib/scope";
import { vInvoiceStatus } from "./lib/validators";
import type { Scope } from "./lib/validators";

const vFeature = literals(
  "invoices",
  "expenses",
  "clients",
  "settings",
  "audit",
  "reports",
  "recurring_invoices",
  "receipt_scanning",
  "multi_currency",
);

const clientDoc = (scope: Pick<Scope, "scopeId" | "scopeKind">, name: string) => ({
  scopeId: scope.scopeId,
  scopeKind: scope.scopeKind,
  name,
  currency: "USD",
  isArchived: false,
  outstandingCents: 0,
  totalBilledCents: 0,
  totalPaidCents: 0,
});

// --- Reads ---------------------------------------------------------------

export const whoami = scopedQuery({
  args: {},
  handler: async (ctx) => ctx.scope,
});

/** Deliberately has no scopeId filter: row-level security must still hold. */
export const listClientsUnfiltered = scopedQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("clients").collect(),
});

export const getClient = scopedQuery({
  args: { id: v.id("clients") },
  handler: async (ctx, { id }) => ctx.db.get("clients", id),
});

export const getClientOrThrow = scopedQuery({
  args: { id: v.id("clients") },
  handler: async (ctx, { id }) => getInScope(ctx, "clients", id),
});

export const getInvoice = scopedQuery({
  args: { id: v.id("invoices") },
  handler: async (ctx, { id }) => ctx.db.get("invoices", id),
});

export const listUsers = scopedQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("users").collect(),
});

export const listAudit = scopedQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("auditLogs").collect(),
});

export const listUsage = scopedQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("usageCounters").collect(),
});

// --- Writes --------------------------------------------------------------

export const createClient = scopedMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    requireCapability(ctx.scope, "clients.write");
    return await ctx.db.insert("clients", clientDoc(ctx.scope, name));
  },
});

export const renameClient = scopedMutation({
  args: { id: v.id("clients"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    await ctx.db.patch("clients", id, { name });
  },
});

export const deleteClient = scopedMutation({
  args: { id: v.id("clients") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete("clients", id);
  },
});

/** Insert a row claiming a scope other than the caller's. */
export const forgeClient = scopedMutation({
  args: { scopeId: v.string() },
  handler: async (ctx, { scopeId }) => {
    return await ctx.db.insert("clients", {
      ...clientDoc(ctx.scope, "Forged"),
      scopeId,
    });
  },
});

/** Try to move an in-scope row to another tenant. */
export const moveClient = scopedMutation({
  args: { id: v.id("clients"), scopeId: v.string() },
  handler: async (ctx, { id, scopeId }) => {
    await ctx.db.patch("clients", id, { scopeId });
  },
});

/** Touch only a denormalized field. */
export const bumpClientBalance = scopedMutation({
  args: { id: v.id("clients"), outstandingCents: v.number() },
  handler: async (ctx, { id, outstandingCents }) => {
    await ctx.db.patch("clients", id, { outstandingCents });
  },
});

export const writeAuditDirectly = scopedMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("auditLogs", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      actorUserId: ctx.scope.userId,
      actorRole: ctx.scope.role,
      action: "create",
      entityTable: "clients",
      entityId: "forged",
      entityLabel: "Forged",
      summary: "Forged",
    });
  },
});

export const writeSubscriptionDirectly = scopedMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("subscriptions", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      planKey: "business",
      clerkPlanSlug: "business_org",
      status: "active",
      features: [],
    });
  },
});

export const createInvoice = scopedMutation({
  args: {
    clientId: v.id("clients"),
    status: vInvoiceStatus,
    totalCents: v.number(),
  },
  handler: async (ctx, { clientId, status, totalCents }) => {
    return await ctx.db.insert("invoices", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      clientId,
      invoiceNumber: "INV-0001",
      status,
      issueDate: 0,
      dueDate: 0,
      currency: "USD",
      subtotalCents: totalCents,
      taxCents: 0,
      discountCents: 0,
      totalCents,
      paidCents: 0,
    });
  },
});

export const setInvoiceStatus = scopedMutation({
  args: { id: v.id("invoices"), status: vInvoiceStatus },
  handler: async (ctx, { id, status }) => {
    await ctx.db.patch("invoices", id, { status });
  },
});

export const deleteInvoice = scopedMutation({
  args: { id: v.id("invoices") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete("invoices", id);
  },
});

export const recordPayment = scopedMutation({
  args: {
    invoiceId: v.id("invoices"),
    clientId: v.id("clients"),
    amountCents: v.number(),
  },
  handler: async (ctx, { invoiceId, clientId, amountCents }) => {
    return await ctx.db.insert("payments", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      invoiceId,
      clientId,
      amountCents,
      paidAt: 0,
      method: "bank_transfer",
    });
  },
});

export const deletePayment = scopedMutation({
  args: { id: v.id("payments") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete("payments", id);
  },
});

/** Inserts a recurring template. Contains no plan check of its own. */
export const createRecurring = scopedMutation({
  args: { clientId: v.id("clients") },
  handler: async (ctx, { clientId }) => {
    return await ctx.db.insert("recurringInvoices", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      clientId,
      frequency: "monthly",
      startDate: 0,
      nextRunAt: 0,
      isActive: true,
      currency: "USD",
      paymentTermsDays: 30,
      discountCents: 0,
    });
  },
});

/** Stands in for a query gated on a premium feature (e.g. reports). */
export const gate = scopedQuery({
  args: { feature: vFeature },
  handler: async (ctx, { feature }) => {
    const entitlements = await requireFeature(ctx, feature);
    return entitlements.planKey;
  },
});

/** Stands in for any Owner-only action (billing, org deletion). */
export const manageBilling = scopedMutation({
  args: {},
  handler: async (ctx) => {
    requireCapability(ctx.scope, "billing.manage");
    return ctx.scope.scopeId;
  },
});

export const orgPing = orgOnlyMutation({
  args: {},
  handler: async (ctx) => ctx.scope.scopeId,
});

/** Trusted-caller variant: the scope is an explicit argument. */
export const seedClient = internalScopedMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) =>
    await ctx.db.insert("clients", clientDoc(ctx.scope, name)),
});
