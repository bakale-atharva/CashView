import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vAddress,
  vAuditAction,
  vInvoiceStatus,
  vOcrStatus,
  vOcrSuggestion,
  vPlanKey,
  vRecurringFrequency,
  vScopeKind,
  vUsageMetric,
} from "./lib/validators";

// Conventions
// - Tenancy: every tenant table carries `scopeId` (Clerk org id, or the Clerk
//   user id in personal scope) and `scopeKind`. Every index starts with
//   `scopeId`, so a query cannot be written that spans tenants. The only
//   deliberate exceptions are marked "UNSCOPED" below, and are reachable only
//   from internal functions or the public invoice link.
// - Money is integer cents (a float64 holding a whole number), never decimals.
// - Dates are epoch milliseconds. Date-only fields (issueDate, dueDate, ...)
//   hold UTC midnight of the day.
const scoped = {
  scopeId: v.string(),
  scopeKind: vScopeKind,
};

export default defineSchema({
  // --- Synced from Clerk (written only by webhook handlers) ---------------

  // Global, not tenant-scoped.
  users: defineTable({
    clerkUserId: v.string(), // identity.subject; what Clerk webhooks send
    tokenIdentifier: v.string(), // `${issuer}|${subject}`; globally unique
    email: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  })
    .index("by_clerkUserId", ["clerkUserId"])
    .index("by_tokenIdentifier", ["tokenIdentifier"]),

  // Global, not tenant-scoped.
  organizations: defineTable({
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  }).index("by_clerkOrgId", ["clerkOrgId"]),

  // One row per (org, user). `scopeId` is the org id.
  memberships: defineTable({
    scopeId: v.string(),
    clerkUserId: v.string(),
    role: v.string(), // raw Clerk role key, e.g. "org:admin"
    joinedAt: v.number(),
  }).index("by_scopeId_and_clerkUserId", ["scopeId", "clerkUserId"]),

  // Entitlement source of truth, synced from Clerk Billing webhooks.
  subscriptions: defineTable({
    ...scoped,
    planKey: vPlanKey,
    clerkPlanSlug: v.string(),
    clerkSubscriptionId: v.optional(v.string()),
    clerkSubscriptionItemId: v.optional(v.string()),
    status: v.string(), // Clerk's status string; not narrowed so unknown values never fail a webhook
    features: v.array(v.string()),
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
  })
    .index("by_scopeId", ["scopeId"])
    .index("by_scopeId_and_clerkSubscriptionItemId", [
      "scopeId",
      "clerkSubscriptionItemId",
    ]),

  // --- Tenant data ---------------------------------------------------------

  // Exact quota counts; maintained by triggers (never .collect().length).
  usageCounters: defineTable({
    ...scoped,
    metric: vUsageMetric,
    period: v.string(), // "all" or "YYYY-MM"
    count: v.number(),
  }).index("by_scopeId_and_metric_and_period", ["scopeId", "metric", "period"]),

  // One document per scope.
  scopeSettings: defineTable({
    ...scoped,
    // Business identity
    businessName: v.optional(v.string()),
    address: v.optional(vAddress),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    taxId: v.optional(v.string()),
    // Branding
    logoStorageId: v.optional(v.id("_storage")),
    brandColor: v.optional(v.string()),
    invoiceTemplate: v.optional(v.string()),
    // Invoice defaults
    currency: v.string(),
    defaultTaxRatePct: v.number(),
    invoiceNumberPrefix: v.string(),
    nextInvoiceSeq: v.number(),
    paymentTermsDays: v.number(),
    footerNote: v.optional(v.string()),
  }).index("by_scopeId", ["scopeId"]),

  clients: defineTable({
    ...scoped,
    name: v.string(),
    company: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    billingAddress: v.optional(vAddress),
    notes: v.optional(v.string()),
    currency: v.string(),
    isArchived: v.boolean(),
    // Denormalized; recomputed by triggers on invoices and payments.
    outstandingCents: v.number(),
    totalBilledCents: v.number(),
    totalPaidCents: v.number(),
  })
    .index("by_scopeId_and_isArchived", ["scopeId", "isArchived"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["scopeId", "isArchived"],
    }),

  invoices: defineTable({
    ...scoped,
    clientId: v.id("clients"),
    invoiceNumber: v.string(),
    status: vInvoiceStatus,
    issueDate: v.number(),
    dueDate: v.number(),
    currency: v.string(),
    exchangeRate: v.optional(v.number()), // to the scope's base currency
    subtotalCents: v.number(),
    taxCents: v.number(),
    discountCents: v.number(),
    totalCents: v.number(),
    paidCents: v.number(),
    notes: v.optional(v.string()),
    // Minted when the invoice is sent; the capability behind the public link.
    publicToken: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    viewedAt: v.optional(v.number()),
    paidAt: v.optional(v.number()),
    recurringTemplateId: v.optional(v.id("recurringInvoices")),
  })
    .index("by_scopeId_and_status_and_dueDate", [
      "scopeId",
      "status",
      "dueDate",
    ])
    .index("by_scopeId_and_clientId_and_issueDate", [
      "scopeId",
      "clientId",
      "issueDate",
    ])
    .index("by_scopeId_and_issueDate", ["scopeId", "issueDate"])
    .index("by_scopeId_and_invoiceNumber", ["scopeId", "invoiceNumber"])
    // UNSCOPED: the daily overdue job scans open invoices across every tenant.
    // Only an internal function may use it.
    .index("by_status_and_dueDate", ["status", "dueDate"])
    // UNSCOPED: the public link resolves a request by token alone. The token
    // is the capability; only convex/public.ts may use this index.
    .index("by_publicToken", ["publicToken"]),

  // Child rows, not an embedded array (documents must not hold unbounded lists).
  invoiceLineItems: defineTable({
    ...scoped,
    invoiceId: v.id("invoices"),
    position: v.number(),
    description: v.string(),
    quantity: v.number(),
    unitPriceCents: v.number(),
    taxRatePct: v.number(),
    amountCents: v.number(),
  }).index("by_scopeId_and_invoiceId_and_position", [
    "scopeId",
    "invoiceId",
    "position",
  ]),

  payments: defineTable({
    ...scoped,
    invoiceId: v.id("invoices"),
    clientId: v.id("clients"),
    amountCents: v.number(),
    paidAt: v.number(),
    method: v.string(),
    reference: v.optional(v.string()),
  })
    .index("by_scopeId_and_invoiceId", ["scopeId", "invoiceId"])
    .index("by_scopeId_and_clientId", ["scopeId", "clientId"])
    .index("by_scopeId_and_paidAt", ["scopeId", "paidAt"]),

  recurringInvoices: defineTable({
    ...scoped,
    clientId: v.id("clients"),
    frequency: vRecurringFrequency,
    startDate: v.number(),
    endDate: v.optional(v.number()),
    nextRunAt: v.number(),
    isActive: v.boolean(),
    // Template payload; line items live in recurringLineItems.
    currency: v.string(),
    paymentTermsDays: v.number(),
    discountCents: v.number(),
    notes: v.optional(v.string()),
    // What the last scheduled run did, so a template that stopped generating
    // can say why.
    lastRunAt: v.optional(v.number()),
    lastInvoiceId: v.optional(v.id("invoices")),
    lastError: v.optional(v.string()),
  })
    .index("by_scopeId_and_clientId", ["scopeId", "clientId"])
    // UNSCOPED: the daily cron scans due templates across every tenant. Only
    // an internalMutation may use it.
    .index("by_isActive_and_nextRunAt", ["isActive", "nextRunAt"]),

  recurringLineItems: defineTable({
    ...scoped,
    recurringInvoiceId: v.id("recurringInvoices"),
    position: v.number(),
    description: v.string(),
    quantity: v.number(),
    unitPriceCents: v.number(),
    taxRatePct: v.number(),
  }).index("by_scopeId_and_recurringInvoiceId_and_position", [
    "scopeId",
    "recurringInvoiceId",
    "position",
  ]),

  expenses: defineTable({
    ...scoped,
    categoryId: v.id("expenseCategories"),
    vendor: v.string(),
    description: v.optional(v.string()),
    amountCents: v.number(),
    taxCents: v.number(),
    currency: v.string(),
    spentAt: v.number(),
    paymentMethod: v.string(),
    receiptStorageId: v.optional(v.id("_storage")),
    ocrStatus: vOcrStatus,
    ocrRaw: v.optional(v.string()), // raw model output, kept for debugging
    // A scan only ever proposes; the user confirms (applyScan) or dismisses.
    ocrSuggestion: v.optional(vOcrSuggestion),
    ocrError: v.optional(v.string()),
    ocrStartedAt: v.optional(v.number()), // when a scan began; lets a stuck one be retried
    isBillable: v.boolean(),
    clientId: v.optional(v.id("clients")),
  })
    .index("by_scopeId_and_spentAt", ["scopeId", "spentAt"])
    .index("by_scopeId_and_categoryId_and_spentAt", [
      "scopeId",
      "categoryId",
      "spentAt",
    ])
    .index("by_scopeId_and_clientId", ["scopeId", "clientId"])
    // UNSCOPED: answers "has any org already claimed this stored file?" so one
    // org cannot attach another's receipt. Only an internal query may use it.
    .index("by_receiptStorageId", ["receiptStorageId"]),

  expenseCategories: defineTable({
    ...scoped,
    name: v.string(),
    isDefault: v.boolean(), // seeded on first use
  }).index("by_scopeId_and_name", ["scopeId", "name"]),

  // Append-only. Written by triggers; never by scoped functions directly.
  // When it happened is the system `_creationTime`.
  auditLogs: defineTable({
    ...scoped,
    actorUserId: v.string(),
    actorEmail: v.optional(v.string()), // not in the JWT; looked up from `users`
    actorRole: v.string(),
    action: vAuditAction,
    entityTable: v.string(),
    entityId: v.string(),
    entityLabel: v.string(),
    summary: v.string(),
    changes: v.optional(
      v.array(
        v.object({
          field: v.string(),
          from: v.union(v.string(), v.number(), v.boolean(), v.null()),
          to: v.union(v.string(), v.number(), v.boolean(), v.null()),
        }),
      ),
    ),
  })
    .index("by_scopeId", ["scopeId"])
    .index("by_scopeId_and_entityTable_and_entityId", [
      "scopeId",
      "entityTable",
      "entityId",
    ])
    .index("by_scopeId_and_actorUserId", ["scopeId", "actorUserId"]),
});
