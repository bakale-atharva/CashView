import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { getAll } from "convex-helpers/server/relationships";
import type { Id } from "./_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "./_generated/server";
import { startOfUtcDay } from "./lib/dates";
import { baseCurrency } from "./lib/currency";
import { requireFeature } from "./lib/entitlements";
import { conflict, invalidInput } from "./lib/errors";
import { getInScope, scopedMutation, scopedQuery } from "./lib/functions";
import { MAX_LINES, computeTotals, vLineItemInput } from "./lib/invoiceMath";
import { occurrenceOnOrAfter } from "./lib/recurrence";
import { requireCapability } from "./lib/scope";
import { vRecurringFrequency } from "./lib/validators";
import type { Scope } from "./lib/validators";

/**
 * Recurring invoice templates. A template describes an invoice (client, lines,
 * terms) and a schedule; the daily job in recurringCron.ts turns each due one
 * into a *draft* invoice for a person to review and send. Nothing is ever sent
 * automatically.
 *
 * Available on Pro and above (`recurring_invoices`). Templates are in the base
 * currency only: there is no exchange-rate source to convert at run time.
 */

type Ctx = { db: DatabaseWriter; scope: Scope };

const vTemplateInput = {
  clientId: v.id("clients"),
  frequency: vRecurringFrequency,
  /** The first run. Later runs are counted from this date. */
  startDate: v.number(),
  endDate: v.optional(v.number()),
  paymentTermsDays: v.optional(v.number()),
  discountCents: v.optional(v.number()),
  notes: v.optional(v.string()),
  lineItems: v.array(vLineItemInput),
};

async function prepare(
  ctx: Ctx,
  input: {
    clientId: Id<"clients">;
    frequency: "weekly" | "monthly" | "quarterly" | "yearly";
    startDate: number;
    endDate?: number;
    paymentTermsDays?: number;
    discountCents?: number;
    notes?: string;
    lineItems: { description: string; quantity: number; unitPriceCents: number; taxRatePct: number }[];
  },
  now: number,
) {
  await requireFeature(ctx, "recurring_invoices");

  const client = await getInScope(ctx, "clients", input.clientId);
  if (client.isArchived) throw conflict("client_archived");
  const base = await baseCurrency(ctx);
  if (client.currency !== base) {
    throw invalidInput("clientId", `Recurring invoices are in ${base} only.`);
  }

  if (!Number.isFinite(input.startDate) || input.startDate < 0) {
    throw invalidInput("startDate", "Enter a valid date.");
  }
  const startDate = startOfUtcDay(input.startDate);
  let endDate: number | undefined;
  if (input.endDate !== undefined) {
    if (!Number.isFinite(input.endDate) || input.endDate < 0) {
      throw invalidInput("endDate", "Enter a valid date.");
    }
    endDate = startOfUtcDay(input.endDate);
    if (endDate < startDate) throw invalidInput("endDate", "The end date cannot be before the start date.");
  }

  const settings = await ctx.db
    .query("scopeSettings")
    .withIndex("by_scopeId", (q) => q.eq("scopeId", ctx.scope.scopeId))
    .first();
  const paymentTermsDays = input.paymentTermsDays ?? settings?.paymentTermsDays ?? 30;
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 365) {
    throw invalidInput("paymentTermsDays", "Enter a whole number of days from 0 to 365.");
  }

  // Validates the lines and the discount exactly as an invoice would.
  const totals = computeTotals(input.lineItems, input.discountCents ?? 0);

  const notes = input.notes?.trim() || undefined;
  if (notes !== undefined && notes.length > 5000) {
    throw invalidInput("notes", "Must be 5000 characters or fewer.");
  }

  // Creating or editing never backfills: the next run is the first scheduled
  // date that is not already in the past.
  const nextRunAt = occurrenceOnOrAfter(startDate, input.frequency, startOfUtcDay(now));
  return { client, startDate, endDate, paymentTermsDays, totals, notes, nextRunAt };
}

async function writeTemplateLines(
  ctx: Ctx,
  templateId: Id<"recurringInvoices">,
  lines: { position: number; description: string; quantity: number; unitPriceCents: number; taxRatePct: number }[],
) {
  for (const line of lines) {
    await ctx.db.insert("recurringLineItems", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      recurringInvoiceId: templateId,
      position: line.position,
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      taxRatePct: line.taxRatePct,
    });
  }
}

async function readTemplateLines(
  ctx: { db: DatabaseReader; scope: Scope },
  templateId: Id<"recurringInvoices">,
) {
  return await ctx.db
    .query("recurringLineItems")
    .withIndex("by_scopeId_and_recurringInvoiceId_and_position", (q) =>
      q.eq("scopeId", ctx.scope.scopeId).eq("recurringInvoiceId", templateId),
    )
    .take(MAX_LINES + 1);
}

// --- Reads -----------------------------------------------------------------

/** A page of templates with each client's name. Readable on any plan. */
export const list = scopedQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    requireCapability(ctx.scope, "invoices.read");
    const result = await ctx.db
      .query("recurringInvoices")
      .withIndex("by_scopeId_and_clientId", (q) => q.eq("scopeId", ctx.scope.scopeId))
      .paginate(paginationOpts);
    const clients = await getAll(ctx.db, "clients", result.page.map((t) => t.clientId));
    return {
      ...result,
      page: result.page.map((template, i) => ({ ...template, clientName: clients[i]?.name ?? null })),
    };
  },
});

export const get = scopedQuery({
  args: { id: v.id("recurringInvoices") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "invoices.read");
    const template = await getInScope(ctx, "recurringInvoices", id);
    const [lineItems, client] = await Promise.all([
      readTemplateLines(ctx, id),
      ctx.db.get("clients", template.clientId),
    ]);
    return { template, lineItems, client: client && { _id: client._id, name: client.name } };
  },
});

// --- Writes ----------------------------------------------------------------

export const create = scopedMutation({
  args: vTemplateInput,
  handler: async (ctx, args) => {
    requireCapability(ctx.scope, "invoices.write");
    const p = await prepare(ctx, args, Date.now());

    const id = await ctx.db.insert("recurringInvoices", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      clientId: p.client._id,
      frequency: args.frequency,
      startDate: p.startDate,
      endDate: p.endDate,
      nextRunAt: p.nextRunAt,
      isActive: true,
      currency: p.client.currency,
      paymentTermsDays: p.paymentTermsDays,
      discountCents: p.totals.discountCents,
      notes: p.notes,
    });
    await writeTemplateLines(ctx, id, p.totals.lines);
    return id;
  },
});

/** Replaces a template's content and schedule. Omitted optional fields are cleared. */
export const update = scopedMutation({
  args: { id: v.id("recurringInvoices"), ...vTemplateInput },
  handler: async (ctx, { id, ...args }) => {
    requireCapability(ctx.scope, "invoices.write");
    await getInScope(ctx, "recurringInvoices", id);
    const p = await prepare(ctx, args, Date.now());

    await ctx.db.patch("recurringInvoices", id, {
      clientId: p.client._id,
      frequency: args.frequency,
      startDate: p.startDate,
      endDate: p.endDate,
      nextRunAt: p.nextRunAt,
      currency: p.client.currency,
      paymentTermsDays: p.paymentTermsDays,
      discountCents: p.totals.discountCents,
      notes: p.notes,
      lastError: undefined,
    });
    for (const line of await readTemplateLines(ctx, id)) {
      await ctx.db.delete("recurringLineItems", line._id);
    }
    await writeTemplateLines(ctx, id, p.totals.lines);
  },
});

/** Stops generating. The template and its history are kept. */
export const pause = scopedMutation({
  args: { id: v.id("recurringInvoices") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "invoices.write");
    await getInScope(ctx, "recurringInvoices", id);
    await ctx.db.patch("recurringInvoices", id, { isActive: false });
  },
});

/** Starts again from the next scheduled date, without catching up on what was missed. */
export const resume = scopedMutation({
  args: { id: v.id("recurringInvoices") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "invoices.write");
    await requireFeature(ctx, "recurring_invoices");
    const template = await getInScope(ctx, "recurringInvoices", id);

    const nextRunAt = occurrenceOnOrAfter(
      template.startDate,
      template.frequency,
      startOfUtcDay(Date.now()),
    );
    if (template.endDate !== undefined && nextRunAt > template.endDate) {
      throw conflict("schedule_finished");
    }
    await ctx.db.patch("recurringInvoices", id, {
      isActive: true,
      nextRunAt,
      lastError: undefined,
    });
  },
});

/** Deletes a template and its lines. Invoices it already produced are kept. */
export const remove = scopedMutation({
  args: { id: v.id("recurringInvoices") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "invoices.write");
    await getInScope(ctx, "recurringInvoices", id);
    for (const line of await readTemplateLines(ctx, id)) {
      await ctx.db.delete("recurringLineItems", line._id);
    }
    await ctx.db.delete("recurringInvoices", id);
  },
});
