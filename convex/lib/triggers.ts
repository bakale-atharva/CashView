import { ConvexError } from "convex/values";
import { Triggers } from "convex-helpers/server/triggers";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { DatabaseWriter } from "../_generated/server";
import { monthOf } from "./period";
import { WRITABLE_TENANT_TABLES } from "./tables";
import type { Scope, UsageMetric } from "./validators";

/**
 * Audit, quota counters and client balances, maintained by construction.
 *
 * These run inside the same transaction as the write that caused them, and
 * only for writes made through the trigger-enabled writer that scoped
 * mutations receive (see functions.ts). A mutation cannot skip them, because
 * they are not in the mutation. Webhook sync handlers use the raw `db` and so
 * bypass them on purpose: they write global/synced tables and have no actor.
 */

/** What triggers receive: the scope, plus the trigger-aware db. */
export type TriggerCtx = { db: DatabaseWriter; scope: Scope };
type Ctx = TriggerCtx & { innerDb: DatabaseWriter };

export const triggers = new Triggers<DataModel, TriggerCtx>();

// --- Scope is immutable ----------------------------------------------------
// The row-level-security modify rule only inspects the document as it was
// before the write, so a patch could otherwise move a row to another tenant.

for (const table of WRITABLE_TENANT_TABLES) {
  triggers.register(table, async (_ctx, change) => {
    if (
      change.operation === "update" &&
      (change.newDoc.scopeId !== change.oldDoc.scopeId ||
        change.newDoc.scopeKind !== change.oldDoc.scopeKind)
    ) {
      throw new ConvexError({ code: "SCOPE_IMMUTABLE", table });
    }
  });
}

// --- Audit trail -----------------------------------------------------------

type AuditConfig = {
  noun: string;
  label: (doc: Record<string, unknown>) => string;
  /** Fields whose changes are bookkeeping, not something a user did. */
  ignore?: readonly string[];
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

const AUDITED = {
  clients: {
    noun: "client",
    label: (d) => str(d.name),
    ignore: ["outstandingCents", "totalBilledCents", "totalPaidCents"],
  },
  invoices: { noun: "invoice", label: (d) => str(d.invoiceNumber) },
  invoiceLineItems: { noun: "invoice line item", label: (d) => str(d.description) },
  payments: {
    noun: "payment",
    label: (d) =>
      typeof d.amountCents === "number" ? (d.amountCents / 100).toFixed(2) : "",
  },
  expenses: { noun: "expense", label: (d) => str(d.vendor) },
  recurringInvoices: {
    noun: "recurring invoice",
    label: (d) => str(d.frequency),
  },
  scopeSettings: {
    noun: "settings",
    label: () => "Settings",
    // Bumped on every invoice created; not a user edit.
    ignore: ["nextInvoiceSeq"],
  },
} satisfies Record<string, AuditConfig>;

type AuditedTable = keyof typeof AUDITED;

type FieldChange = {
  field: string;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
};

const MAX_VALUE_LENGTH = 500;

function toAuditValue(value: unknown): FieldChange["from"] {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_VALUE_LENGTH
    ? `${text.slice(0, MAX_VALUE_LENGTH)}…`
    : text;
}

function diff(
  oldDoc: Record<string, unknown>,
  newDoc: Record<string, unknown>,
  ignore: readonly string[] = [],
): FieldChange[] {
  const skip = new Set(["_id", "_creationTime", ...ignore]);
  const fields = new Set([...Object.keys(oldDoc), ...Object.keys(newDoc)]);
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (skip.has(field)) continue;
    if (JSON.stringify(oldDoc[field]) === JSON.stringify(newDoc[field])) {
      continue;
    }
    changes.push({
      field,
      from: toAuditValue(oldDoc[field]),
      to: toAuditValue(newDoc[field]),
    });
  }
  return changes;
}

// The token carries no email, so it is looked up once per function call.
const emailCache = new WeakMap<Scope, string | undefined>();

async function actorEmail(ctx: Ctx): Promise<string | undefined> {
  if (emailCache.has(ctx.scope)) return emailCache.get(ctx.scope);
  const user = await ctx.innerDb
    .query("users")
    .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", ctx.scope.userId))
    .first();
  emailCache.set(ctx.scope, user?.email);
  return user?.email;
}

type ChangeLike = {
  id: string;
  operation: "insert" | "update" | "delete";
  oldDoc: Record<string, unknown> | null;
  newDoc: Record<string, unknown> | null;
};

async function recordAudit(ctx: Ctx, table: AuditedTable, change: ChangeLike) {
  const config: AuditConfig = AUDITED[table];
  const doc = change.newDoc ?? change.oldDoc;
  if (doc === null) return;

  let changes: FieldChange[] | undefined;
  if (change.operation === "update" && change.oldDoc && change.newDoc) {
    changes = diff(change.oldDoc, change.newDoc, config.ignore);
    // Only bookkeeping fields moved; nothing a person did.
    if (changes.length === 0) return;
  }

  const verb =
    change.operation === "insert"
      ? "Created"
      : change.operation === "delete"
        ? "Deleted"
        : "Updated";
  const label = config.label(doc);
  const fields = changes ? ` (${changes.map((c) => c.field).join(", ")})` : "";

  await ctx.innerDb.insert("auditLogs", {
    scopeId: ctx.scope.scopeId,
    scopeKind: ctx.scope.scopeKind,
    actorUserId: ctx.scope.userId,
    actorEmail: await actorEmail(ctx),
    actorRole: ctx.scope.role,
    action:
      change.operation === "insert"
        ? "create"
        : change.operation === "delete"
          ? "delete"
          : "update",
    entityTable: table,
    entityId: change.id,
    entityLabel: label,
    summary: `${verb} ${config.noun} "${label}"${fields}`,
    changes,
  });
}

for (const table of Object.keys(AUDITED) as AuditedTable[]) {
  triggers.register(table, (ctx, change) => recordAudit(ctx, table, change));
}

// --- Usage counters --------------------------------------------------------
// Exact counts for quotas; Convex has no count operator and the guidelines
// forbid `.collect().length`.

async function bumpCounter(
  db: DatabaseWriter,
  scope: { scopeId: string; scopeKind: Scope["scopeKind"] },
  metric: UsageMetric,
  period: string,
  delta: 1 | -1,
) {
  const row = await db
    .query("usageCounters")
    .withIndex("by_scopeId_and_metric_and_period", (q) =>
      q
        .eq("scopeId", scope.scopeId)
        .eq("metric", metric)
        .eq("period", period),
    )
    .unique();
  if (row === null) {
    if (delta > 0) {
      await db.insert("usageCounters", {
        scopeId: scope.scopeId,
        scopeKind: scope.scopeKind,
        metric,
        period,
        count: delta,
      });
    }
    return;
  }
  await db.patch("usageCounters", row._id, {
    count: Math.max(0, row.count + delta),
  });
}

// Counts clients that exist; archiving does not free a slot.
triggers.register("clients", async (ctx, change) => {
  if (change.operation === "insert") {
    await bumpCounter(ctx.innerDb, change.newDoc, "clients", "all", 1);
  } else if (change.operation === "delete") {
    await bumpCounter(ctx.innerDb, change.oldDoc, "clients", "all", -1);
  }
});

// Bucketed by when the invoice was *created*, not by its issue date: the
// issue date is user-editable, and backdating would otherwise dodge the quota.
triggers.register("invoices", async (ctx, change) => {
  if (change.operation === "insert") {
    const period = monthOf(change.newDoc._creationTime);
    await bumpCounter(ctx.innerDb, change.newDoc, "invoices", period, 1);
  } else if (change.operation === "delete") {
    const period = monthOf(change.oldDoc._creationTime);
    await bumpCounter(ctx.innerDb, change.oldDoc, "invoices", period, -1);
  }
});

// --- Client balances -------------------------------------------------------
// Each invoice contributes to its client's totals only once it has been
// issued. Deltas are applied from the before/after documents, so the totals
// move in the same transaction as the invoice change that caused them.

const ISSUED = new Set<Doc<"invoices">["status"]>([
  "sent",
  "viewed",
  "paid",
  "overdue",
]);

type Contribution = { billed: number; paid: number };
const NONE: Contribution = { billed: 0, paid: 0 };

function contribution(invoice: Doc<"invoices"> | null): Contribution {
  if (invoice === null || !ISSUED.has(invoice.status)) return NONE;
  return { billed: invoice.totalCents, paid: invoice.paidCents };
}

async function applyToClient(
  db: DatabaseWriter,
  clientId: Id<"clients">,
  scopeId: string,
  billed: number,
  paid: number,
) {
  if (billed === 0 && paid === 0) return;
  const client = await db.get("clients", clientId);
  if (client === null) return;
  if (client.scopeId !== scopeId) {
    throw new ConvexError({ code: "SCOPE_MISMATCH", table: "clients" });
  }
  await db.patch("clients", clientId, {
    totalBilledCents: client.totalBilledCents + billed,
    totalPaidCents: client.totalPaidCents + paid,
    outstandingCents: client.outstandingCents + billed - paid,
  });
}

triggers.register("invoices", async (ctx, change) => {
  const before = contribution(change.oldDoc);
  const after = contribution(change.newDoc);
  const doc = change.newDoc ?? change.oldDoc;

  if (
    change.operation === "update" &&
    change.oldDoc.clientId !== change.newDoc.clientId
  ) {
    await applyToClient(
      ctx.innerDb,
      change.oldDoc.clientId,
      doc.scopeId,
      -before.billed,
      -before.paid,
    );
    await applyToClient(
      ctx.innerDb,
      change.newDoc.clientId,
      doc.scopeId,
      after.billed,
      after.paid,
    );
    return;
  }

  await applyToClient(
    ctx.innerDb,
    doc.clientId,
    doc.scopeId,
    after.billed - before.billed,
    after.paid - before.paid,
  );
});

// An invoice's paidCents is always the sum of its payments. Deriving it here
// means recording, editing or deleting a payment cannot leave it stale, and
// the invoice write it causes flows on to the client balances above.
triggers.register("payments", async (ctx, change) => {
  const invoiceIds = new Set<Id<"invoices">>();
  if (change.oldDoc) invoiceIds.add(change.oldDoc.invoiceId);
  if (change.newDoc) invoiceIds.add(change.newDoc.invoiceId);

  for (const invoiceId of invoiceIds) {
    const invoice = await ctx.innerDb.get("invoices", invoiceId);
    if (invoice === null) continue;

    let paidCents = 0;
    for await (const payment of ctx.innerDb
      .query("payments")
      .withIndex("by_scopeId_and_invoiceId", (q) =>
        q.eq("scopeId", invoice.scopeId).eq("invoiceId", invoiceId),
      )) {
      paidCents += payment.amountCents;
    }
    if (paidCents !== invoice.paidCents) {
      await ctx.db.patch("invoices", invoiceId, { paidCents });
    }
  }
});
