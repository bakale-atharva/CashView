import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { getAll } from "convex-helpers/server/relationships";
import type { Id } from "./_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "./_generated/server";
import { requireFeature } from "./lib/entitlements";
import { conflict, invalidInput } from "./lib/errors";
import { getInScope, scopedMutation, scopedQuery } from "./lib/functions";
import {
  MAX_LINES,
  computeTotals,
  formatInvoiceNumber,
  resolveDates,
  vLineItemInput,
} from "./lib/invoiceMath";
import type { ComputedLine } from "./lib/invoiceMath";
import {
  PAYABLE,
  assertTransition,
  statusAfterPaymentChange,
} from "./lib/invoiceStatus";
import { mintPublicToken } from "./lib/publicToken";
import { requireCapability } from "./lib/scope";
import { ensureScopeDefaults, getScopeSettings } from "./lib/scopeDefaults";
import { vInvoiceStatus } from "./lib/validators";
import type { Scope } from "./lib/validators";

/**
 * Invoices and their payments. Business logic only: scoping, row-level
 * security, the monthly invoice quota, usage counters, client balances and the
 * audit trail all come from the scoped builders and their triggers.
 *
 * `Date.now()` is read here, in mutations, and never in a query.
 */

type Ctx = { db: DatabaseWriter; scope: Scope };

const vInvoiceInput = {
  clientId: v.id("clients"),
  issueDate: v.optional(v.number()),
  dueDate: v.optional(v.number()),
  discountCents: v.optional(v.number()),
  /** Units of the scope's base currency per 1 unit of the client's. */
  exchangeRate: v.optional(v.number()),
  notes: v.optional(v.string()),
  lineItems: v.array(vLineItemInput),
};

export async function loadSettings(ctx: Ctx) {
  // The first invoice of a scope that never got its defaults creates them.
  await ensureScopeDefaults(ctx, {
    scopeId: ctx.scope.scopeId,
    scopeKind: ctx.scope.scopeKind,
  });
  const settings = await getScopeSettings(ctx, ctx.scope.scopeId);
  if (settings === null) throw new Error("scopeSettings missing after ensureScopeDefaults");
  return settings;
}

/** Everything create and update share: check the client, price the lines. */
async function prepare(
  ctx: Ctx,
  input: {
    clientId: Id<"clients">;
    issueDate?: number;
    dueDate?: number;
    discountCents?: number;
    exchangeRate?: number;
    notes?: string;
    lineItems: { description: string; quantity: number; unitPriceCents: number; taxRatePct: number }[];
  },
  now: number,
) {
  const client = await getInScope(ctx, "clients", input.clientId);
  if (client.isArchived) throw conflict("client_archived");

  const settings = await loadSettings(ctx);
  const dates = resolveDates(input, settings.paymentTermsDays, now);
  const totals = computeTotals(input.lineItems, input.discountCents ?? 0);

  // An invoice is in its client's currency. Anything but the base currency is
  // the Business-tier feature and needs the rate to convert it back.
  let exchangeRate: number | undefined;
  if (client.currency !== settings.currency) {
    await requireFeature(ctx, "multi_currency");
    const rate = input.exchangeRate;
    if (rate === undefined || !Number.isFinite(rate) || rate <= 0 || rate > 1e6) {
      throw invalidInput(
        "exchangeRate",
        `Enter the exchange rate to ${settings.currency}.`,
      );
    }
    exchangeRate = rate;
  }

  const notes = input.notes?.trim() || undefined;
  if (notes !== undefined && notes.length > 5000) {
    throw invalidInput("notes", "Must be 5000 characters or fewer.");
  }

  return { client, settings, ...dates, totals, currency: client.currency, exchangeRate, notes };
}

/**
 * The next free number. The sequence lives on the settings document and is
 * bumped in this transaction, so two invoices can never take the same one. It
 * skips a number that is already in use (a changed prefix can collide).
 */
export async function allocateNumber(
  ctx: Ctx,
  settings: { _id: Id<"scopeSettings">; nextInvoiceSeq: number; invoiceNumberPrefix: string },
): Promise<string> {
  let seq = settings.nextInvoiceSeq;
  for (let attempts = 0; attempts < 100; attempts++, seq++) {
    const number = formatInvoiceNumber(settings.invoiceNumberPrefix, seq);
    const taken = await ctx.db
      .query("invoices")
      .withIndex("by_scopeId_and_invoiceNumber", (q) =>
        q.eq("scopeId", ctx.scope.scopeId).eq("invoiceNumber", number),
      )
      .first();
    if (taken === null) {
      await ctx.db.patch("scopeSettings", settings._id, { nextInvoiceSeq: seq + 1 });
      return number;
    }
  }
  throw conflict("invoice_number_unavailable");
}

export async function writeLines(ctx: Ctx, invoiceId: Id<"invoices">, lines: ComputedLine[]) {
  for (const line of lines) {
    await ctx.db.insert("invoiceLineItems", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      invoiceId,
      position: line.position,
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      taxRatePct: line.taxRatePct,
      amountCents: line.amountCents,
    });
  }
}

async function readLines(ctx: { db: DatabaseReader; scope: Scope }, invoiceId: Id<"invoices">) {
  return await ctx.db
    .query("invoiceLineItems")
    .withIndex("by_scopeId_and_invoiceId_and_position", (q) =>
      q.eq("scopeId", ctx.scope.scopeId).eq("invoiceId", invoiceId),
    )
    .take(MAX_LINES + 1);
}

/**
 * Brings an invoice's status in line with its payments. The payments trigger
 * has already recomputed `paidCents`; this reads it back and moves the status
 * (paid when covered, reopened when a payment is removed).
 */
async function settleStatus(
  ctx: Ctx,
  invoiceId: Id<"invoices">,
  now: number,
  paidAt: number,
): Promise<void> {
  const invoice = await ctx.db.get("invoices", invoiceId);
  if (invoice === null) return;
  const next = statusAfterPaymentChange(invoice, now);
  if (next === null) return;
  assertTransition(invoice.status, next);
  await ctx.db.patch("invoices", invoiceId, {
    status: next,
    paidAt: next === "paid" ? paidAt : undefined,
  });
}

// --- Reads -----------------------------------------------------------------

/**
 * A page of invoices, newest issued first, with the client's name resolved
 * (one batched read, not one per row). Filter by status or by client.
 */
export const list = scopedQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(vInvoiceStatus),
    clientId: v.optional(v.id("clients")),
  },
  handler: async (ctx, { paginationOpts, status, clientId }) => {
    requireCapability(ctx.scope, "invoices.read");
    const { scopeId } = ctx.scope;

    let result;
    if (clientId !== undefined) {
      const byClient = ctx.db
        .query("invoices")
        .withIndex("by_scopeId_and_clientId_and_issueDate", (q) =>
          q.eq("scopeId", scopeId).eq("clientId", clientId),
        )
        .order("desc");
      result = await (status === undefined
        ? byClient
        : byClient.filter((q) => q.eq(q.field("status"), status))
      ).paginate(paginationOpts);
    } else if (status !== undefined) {
      result = await ctx.db
        .query("invoices")
        .withIndex("by_scopeId_and_status_and_dueDate", (q) =>
          q.eq("scopeId", scopeId).eq("status", status),
        )
        .order("desc")
        .paginate(paginationOpts);
    } else {
      result = await ctx.db
        .query("invoices")
        .withIndex("by_scopeId_and_issueDate", (q) => q.eq("scopeId", scopeId))
        .order("desc")
        .paginate(paginationOpts);
    }

    const clients = await getAll(
      ctx.db,
      "clients",
      result.page.map((invoice) => invoice.clientId),
    );
    return {
      ...result,
      page: result.page.map((invoice, i) => {
        // The link token is shown on the invoice itself, not in every list row.
        const { publicToken, ...row } = invoice;
        void publicToken;
        return {
          ...row,
          balanceCents: invoice.totalCents - invoice.paidCents,
          clientName: clients[i]?.name ?? null,
        };
      }),
    };
  },
});

/** One invoice with its lines, client, payments and (once sent) its link token. */
export const get = scopedQuery({
  args: { id: v.id("invoices") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "invoices.read");
    const invoice = await getInScope(ctx, "invoices", id);

    const [lineItems, payments, client] = await Promise.all([
      readLines(ctx, id),
      ctx.db
        .query("payments")
        .withIndex("by_scopeId_and_invoiceId", (q) =>
          q.eq("scopeId", ctx.scope.scopeId).eq("invoiceId", id),
        )
        .take(200),
      ctx.db.get("clients", invoice.clientId),
    ]);

    return {
      invoice,
      balanceCents: invoice.totalCents - invoice.paidCents,
      lineItems,
      payments,
      client: client && {
        _id: client._id,
        name: client.name,
        company: client.company,
        email: client.email,
        billingAddress: client.billingAddress,
        currency: client.currency,
      },
    };
  },
});

// --- Drafts ----------------------------------------------------------------

/**
 * Creates a draft. Totals are computed here from the lines; there is no total
 * argument to send. Refused with UPGRADE_REQUIRED past the monthly quota by
 * the scoped writer, not by anything in this function.
 */
export const create = scopedMutation({
  args: vInvoiceInput,
  handler: async (ctx, args) => {
    requireCapability(ctx.scope, "invoices.write");
    const now = Date.now();
    const p = await prepare(ctx, args, now);
    const invoiceNumber = await allocateNumber(ctx, p.settings);

    const id = await ctx.db.insert("invoices", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      clientId: p.client._id,
      invoiceNumber,
      status: "draft",
      issueDate: p.issueDate,
      dueDate: p.dueDate,
      currency: p.currency,
      exchangeRate: p.exchangeRate,
      subtotalCents: p.totals.subtotalCents,
      taxCents: p.totals.taxCents,
      discountCents: p.totals.discountCents,
      totalCents: p.totals.totalCents,
      paidCents: 0,
      notes: p.notes,
    });
    await writeLines(ctx, id, p.totals.lines);
    return id;
  },
});

/** Replaces a draft's content. Only drafts are editable; a sent invoice is a record. */
export const update = scopedMutation({
  args: { id: v.id("invoices"), ...vInvoiceInput },
  handler: async (ctx, { id, ...args }) => {
    requireCapability(ctx.scope, "invoices.write");
    const invoice = await getInScope(ctx, "invoices", id);
    if (invoice.status !== "draft") {
      throw conflict("invoice_not_editable", { status: invoice.status });
    }

    const p = await prepare(ctx, args, Date.now());
    await ctx.db.patch("invoices", id, {
      clientId: p.client._id,
      issueDate: p.issueDate,
      dueDate: p.dueDate,
      currency: p.currency,
      exchangeRate: p.exchangeRate,
      subtotalCents: p.totals.subtotalCents,
      taxCents: p.totals.taxCents,
      discountCents: p.totals.discountCents,
      totalCents: p.totals.totalCents,
      notes: p.notes,
    });
    for (const line of await readLines(ctx, id)) {
      await ctx.db.delete("invoiceLineItems", line._id);
    }
    await writeLines(ctx, id, p.totals.lines);
  },
});

/** Deletes a draft (and its lines), which frees its quota slot. */
export const remove = scopedMutation({
  args: { id: v.id("invoices") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "invoices.write");
    const invoice = await getInScope(ctx, "invoices", id);
    if (invoice.status !== "draft") {
      // Anything that has been sent is voided, never erased.
      throw conflict("invoice_not_deletable", { status: invoice.status });
    }
    for (const line of await readLines(ctx, id)) {
      await ctx.db.delete("invoiceLineItems", line._id);
    }
    await ctx.db.delete("invoices", id);
  },
});

// --- Lifecycle -------------------------------------------------------------

/**
 * Sends a draft: flips it to `sent` and mints the public link's token. No
 * email goes out; the caller shares the link `/i/<token>` however they like.
 */
export const send = scopedMutation({
  args: { id: v.id("invoices") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "invoices.send");
    const invoice = await getInScope(ctx, "invoices", id);
    assertTransition(invoice.status, "sent");

    if ((await readLines(ctx, id)).length === 0) {
      throw invalidInput("lineItems", "Add at least one line item.");
    }
    if (invoice.totalCents <= 0) {
      throw invalidInput("totalCents", "An invoice must have an amount to be sent.");
    }

    const publicToken = mintPublicToken();
    await ctx.db.patch("invoices", id, {
      status: "sent",
      sentAt: Date.now(),
      publicToken,
    });
    return { publicToken };
  },
});

/** Voids an invoice that was sent. Terminal: it stays on record and stops counting. */
export const voidInvoice = scopedMutation({
  args: { id: v.id("invoices") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "invoices.write");
    const invoice = await getInScope(ctx, "invoices", id);
    assertTransition(invoice.status, "void");
    await ctx.db.patch("invoices", id, { status: "void" });
  },
});

// --- Payments --------------------------------------------------------------

/**
 * Records a (possibly partial) payment. The payments trigger recomputes the
 * invoice's `paidCents` and the client's balances in this transaction; this
 * then moves the status to `paid` if the invoice is now covered.
 */
export const recordPayment = scopedMutation({
  args: {
    invoiceId: v.id("invoices"),
    amountCents: v.number(),
    paidAt: v.optional(v.number()),
    method: v.string(),
    reference: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireCapability(ctx.scope, "payments.record");
    const invoice = await getInScope(ctx, "invoices", args.invoiceId);
    if (!PAYABLE.includes(invoice.status)) {
      throw conflict("invoice_not_payable", { status: invoice.status });
    }

    const { amountCents } = args;
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw invalidInput("amountCents", "Enter an amount above zero, in whole cents.");
    }
    if (amountCents > invoice.totalCents - invoice.paidCents) {
      throw invalidInput("amountCents", "The payment is more than the amount still owed.");
    }

    const method = args.method.trim();
    if (method === "" || method.length > 50) {
      throw invalidInput("method", "Enter a payment method (up to 50 characters).");
    }
    const reference = args.reference?.trim() || undefined;
    if (reference !== undefined && reference.length > 200) {
      throw invalidInput("reference", "Must be 200 characters or fewer.");
    }

    const now = Date.now();
    const paidAt = args.paidAt ?? now;
    if (!Number.isFinite(paidAt) || paidAt < 0) {
      throw invalidInput("paidAt", "Enter a valid date.");
    }

    const paymentId = await ctx.db.insert("payments", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      invoiceId: invoice._id,
      clientId: invoice.clientId,
      amountCents,
      paidAt,
      method,
      reference,
    });
    await settleStatus(ctx, invoice._id, now, paidAt);
    return paymentId;
  },
});

/** Removes a payment; a paid invoice that is no longer covered is reopened. */
export const deletePayment = scopedMutation({
  args: { id: v.id("payments") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "payments.record");
    const payment = await getInScope(ctx, "payments", id);
    await ctx.db.delete("payments", id);
    const now = Date.now();
    await settleStatus(ctx, payment.invoiceId, now, now);
  },
});
