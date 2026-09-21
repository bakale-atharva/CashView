import { v } from "convex/values";
import { getAll } from "convex-helpers/server/relationships";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { baseCurrency } from "./lib/currency";
import { requireFeature } from "./lib/entitlements";
import { scopedQuery } from "./lib/functions";
import {
  AGING_BUCKETS,
  REPORT_ROW_LIMIT,
  agingBucket,
  assertWithinLimit,
  convert,
  normalizeRange,
  percent,
  periodKey,
  periodRange,
  vGranularity,
} from "./lib/reportMath";
import type { Granularity } from "./lib/reportMath";
import { requireCapability } from "./lib/scope";
import type { Scope } from "./lib/validators";

/**
 * Financial reports. Every one is gated on the `reports` feature (Pro and
 * above) and on `reports.read`, and aggregates on the server over bounded
 * index ranges: the client receives totals and series, never raw rows.
 *
 * Basis. Revenue is accrual: an issued invoice (sent, viewed, paid or overdue;
 * never a draft or void one) counts on its issue date. Cash flow is what was
 * actually received (payments) against what was spent (expenses). Amounts are
 * converted to the scope's base currency with each invoice's stored exchange
 * rate. Anything that cannot be converted (an invoice without a rate, an
 * expense in another currency, which carries none) is left out and counted
 * under `excluded`, so a total is never silently wrong.
 *
 * Time. Queries cannot read the clock, so the range and "as of" date are
 * arguments. `from`/`to` are UTC dates: `from` starts its day, `to` includes
 * all of its day.
 *
 * Scale. Each report reads at most 10,000 rows per table and refuses
 * (RANGE_TOO_LARGE) rather than under-count. `@convex-dev/aggregate` is the
 * documented scale path and is deliberately not installed.
 */

type Ctx = { db: DatabaseReader; scope: Scope };

const ISSUED: ReadonlySet<Doc<"invoices">["status"]> = new Set([
  "sent",
  "viewed",
  "paid",
  "overdue",
]);

async function guard(ctx: Ctx): Promise<string> {
  requireCapability(ctx.scope, "reports.read");
  await requireFeature(ctx, "reports");
  return await baseCurrency(ctx);
}

/** The exchange rate to base for an invoice's currency, or "missing". */
function rateFor(currency: string, base: string, exchangeRate: number | undefined) {
  if (currency === base) return { ok: true as const, rate: undefined };
  if (exchangeRate === undefined) return { ok: false as const };
  return { ok: true as const, rate: exchangeRate };
}

// --- Readers (bounded, converted to the base currency) ----------------------

type InvoiceFact = { at: number; grossCents: number; taxCents: number; netCents: number };

async function invoiceFacts(ctx: Ctx, base: string, from: number, to: number) {
  const rows = await ctx.db
    .query("invoices")
    .withIndex("by_scopeId_and_issueDate", (q) =>
      q.eq("scopeId", ctx.scope.scopeId).gte("issueDate", from).lte("issueDate", to),
    )
    .take(REPORT_ROW_LIMIT + 1);
  assertWithinLimit(rows.length);

  const facts: InvoiceFact[] = [];
  let excluded = 0;
  for (const inv of rows) {
    if (!ISSUED.has(inv.status)) continue;
    const r = rateFor(inv.currency, base, inv.exchangeRate);
    if (!r.ok) {
      excluded++;
      continue;
    }
    const grossCents = convert(inv.totalCents, r.rate);
    const taxCents = convert(inv.taxCents, r.rate);
    // Revenue is net of sales tax (which is owed onward) and after discounts.
    facts.push({ at: inv.issueDate, grossCents, taxCents, netCents: grossCents - taxCents });
  }
  return { facts, excluded };
}

type PaymentFact = { at: number; cents: number };

async function paymentFacts(ctx: Ctx, base: string, from: number, to: number) {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_scopeId_and_paidAt", (q) =>
      q.eq("scopeId", ctx.scope.scopeId).gte("paidAt", from).lte("paidAt", to),
    )
    .take(REPORT_ROW_LIMIT + 1);
  assertWithinLimit(rows.length);

  // A payment is in its invoice's currency, so the invoice supplies the rate.
  const invoiceIds = [...new Set(rows.map((p) => p.invoiceId))];
  const invoices = await getAll(ctx.db, "invoices", invoiceIds);
  const byId = new Map<Id<"invoices">, Doc<"invoices"> | null>(
    invoiceIds.map((id, i) => [id, invoices[i]]),
  );

  const facts: PaymentFact[] = [];
  let excluded = 0;
  for (const payment of rows) {
    const inv = byId.get(payment.invoiceId);
    const r = inv ? rateFor(inv.currency, base, inv.exchangeRate) : { ok: false as const };
    if (!r.ok) {
      excluded++;
      continue;
    }
    facts.push({ at: payment.paidAt, cents: convert(payment.amountCents, r.rate) });
  }
  return { facts, excluded };
}

type ExpenseFact = { at: number; categoryId: Id<"expenseCategories">; cents: number; taxCents: number };

async function expenseFacts(ctx: Ctx, base: string, from: number, to: number) {
  const rows = await ctx.db
    .query("expenses")
    .withIndex("by_scopeId_and_spentAt", (q) =>
      q.eq("scopeId", ctx.scope.scopeId).gte("spentAt", from).lte("spentAt", to),
    )
    .take(REPORT_ROW_LIMIT + 1);
  assertWithinLimit(rows.length);

  const facts: ExpenseFact[] = [];
  let excluded = 0;
  for (const expense of rows) {
    // Expenses carry no exchange rate, so only base-currency ones can be summed.
    if (expense.currency !== base) {
      excluded++;
      continue;
    }
    facts.push({
      at: expense.spentAt,
      categoryId: expense.categoryId,
      cents: expense.amountCents,
      taxCents: expense.taxCents,
    });
  }
  return { facts, excluded };
}

// --- Series helpers ----------------------------------------------------------

function emptySeries<T>(from: number, to: number, granularity: Granularity, blank: () => T) {
  const periods = periodRange(from, to, granularity);
  const byKey = new Map<string, T & { period: string; start: number }>();
  for (const p of periods) byKey.set(p.key, { period: p.key, start: p.start, ...blank() });
  return { periods, byKey };
}

const rangeArgs = {
  from: v.number(),
  to: v.number(),
  granularity: v.optional(vGranularity),
};

// --- Reports -----------------------------------------------------------------

/** Billed and collected per period. */
export const revenue = scopedQuery({
  args: rangeArgs,
  handler: async (ctx, args) => {
    const base = await guard(ctx);
    const granularity = args.granularity ?? "month";
    const { from, to } = normalizeRange(args.from, args.to, granularity);

    const [inv, pay] = await Promise.all([
      invoiceFacts(ctx, base, from, to),
      paymentFacts(ctx, base, from, to),
    ]);
    const { periods, byKey } = emptySeries(from, to, granularity, () => ({
      invoicedCents: 0,
      collectedCents: 0,
      invoiceCount: 0,
    }));
    for (const f of inv.facts) {
      const row = byKey.get(periodKey(f.at, granularity));
      if (row) {
        row.invoicedCents += f.grossCents;
        row.invoiceCount += 1;
      }
    }
    for (const f of pay.facts) {
      const row = byKey.get(periodKey(f.at, granularity));
      if (row) row.collectedCents += f.cents;
    }

    const series = periods.map((p) => byKey.get(p.key)!);
    return {
      currency: base,
      granularity,
      series,
      totals: {
        invoicedCents: series.reduce((s, r) => s + r.invoicedCents, 0),
        collectedCents: series.reduce((s, r) => s + r.collectedCents, 0),
        invoiceCount: series.reduce((s, r) => s + r.invoiceCount, 0),
      },
      excluded: { invoices: inv.excluded, payments: pay.excluded },
    };
  },
});

/**
 * Billed and collected over a range against what is still owed as of a day.
 * The outstanding side is every open invoice, whenever it was issued, aged by
 * how far past due it is.
 */
export const receivables = scopedQuery({
  args: { from: v.number(), to: v.number(), asOf: v.number() },
  handler: async (ctx, args) => {
    const base = await guard(ctx);
    const { from, to } = normalizeRange(args.from, args.to);

    const [inv, pay] = await Promise.all([
      invoiceFacts(ctx, base, from, to),
      paymentFacts(ctx, base, from, to),
    ]);
    const invoicedCents = inv.facts.reduce((s, f) => s + f.grossCents, 0);
    const collectedCents = pay.facts.reduce((s, f) => s + f.cents, 0);

    let outstandingCents = 0;
    let overdueCents = 0;
    let openCount = 0;
    let overdueCount = 0;
    let excludedOpen = 0;
    const aging = new Map(AGING_BUCKETS.map((b) => [b, { bucket: b, cents: 0, count: 0 }]));

    for (const status of ["sent", "viewed", "overdue"] as const) {
      const rows = await ctx.db
        .query("invoices")
        .withIndex("by_scopeId_and_status_and_dueDate", (q) =>
          q.eq("scopeId", ctx.scope.scopeId).eq("status", status),
        )
        .take(REPORT_ROW_LIMIT + 1);
      assertWithinLimit(rows.length);

      for (const row of rows) {
        const r = rateFor(row.currency, base, row.exchangeRate);
        if (!r.ok) {
          excludedOpen++;
          continue;
        }
        const balance = convert(row.totalCents - row.paidCents, r.rate);
        const bucket = agingBucket(row.dueDate, args.asOf);
        const slot = aging.get(bucket)!;
        slot.cents += balance;
        slot.count += 1;
        outstandingCents += balance;
        openCount += 1;
        if (bucket !== "current") {
          overdueCents += balance;
          overdueCount += 1;
        }
      }
    }

    return {
      currency: base,
      range: {
        invoicedCents,
        collectedCents,
        collectionRatePct: percent(collectedCents, invoicedCents),
      },
      outstanding: {
        totalCents: outstandingCents,
        overdueCents,
        openCount,
        overdueCount,
        aging: [...aging.values()],
      },
      excluded: { invoices: inv.excluded, payments: pay.excluded, openInvoices: excludedOpen },
    };
  },
});

/** Revenue (net of tax) against expenses, with a per-period series. */
export const profitAndLoss = scopedQuery({
  args: rangeArgs,
  handler: async (ctx, args) => {
    const base = await guard(ctx);
    const granularity = args.granularity ?? "month";
    const { from, to } = normalizeRange(args.from, args.to, granularity);

    const [inv, exp] = await Promise.all([
      invoiceFacts(ctx, base, from, to),
      expenseFacts(ctx, base, from, to),
    ]);
    const { periods, byKey } = emptySeries(from, to, granularity, () => ({
      revenueCents: 0,
      expensesCents: 0,
      netProfitCents: 0,
    }));
    for (const f of inv.facts) {
      const row = byKey.get(periodKey(f.at, granularity));
      if (row) row.revenueCents += f.netCents;
    }
    for (const f of exp.facts) {
      const row = byKey.get(periodKey(f.at, granularity));
      if (row) row.expensesCents += f.cents;
    }
    const series = periods.map((p) => {
      const row = byKey.get(p.key)!;
      row.netProfitCents = row.revenueCents - row.expensesCents;
      return row;
    });

    const revenueCents = inv.facts.reduce((s, f) => s + f.netCents, 0);
    const expensesCents = exp.facts.reduce((s, f) => s + f.cents, 0);
    return {
      currency: base,
      granularity,
      revenueCents,
      expensesCents,
      netProfitCents: revenueCents - expensesCents,
      marginPct: percent(revenueCents - expensesCents, revenueCents),
      // Shown separately: what was collected for tax, and tax paid on expenses.
      salesTaxCents: inv.facts.reduce((s, f) => s + f.taxCents, 0),
      expenseTaxCents: exp.facts.reduce((s, f) => s + f.taxCents, 0),
      invoiceCount: inv.facts.length,
      expenseCount: exp.facts.length,
      series,
      excluded: { invoices: inv.excluded, expenses: exp.excluded },
    };
  },
});

/** Where the money went: expenses per category, largest first. */
export const expenseBreakdown = scopedQuery({
  args: { from: v.number(), to: v.number() },
  handler: async (ctx, args) => {
    const base = await guard(ctx);
    const { from, to } = normalizeRange(args.from, args.to);
    const exp = await expenseFacts(ctx, base, from, to);

    const totals = new Map<Id<"expenseCategories">, { totalCents: number; count: number }>();
    for (const f of exp.facts) {
      const slot = totals.get(f.categoryId) ?? { totalCents: 0, count: 0 };
      slot.totalCents += f.cents;
      slot.count += 1;
      totals.set(f.categoryId, slot);
    }
    const ids = [...totals.keys()];
    const categories = await getAll(ctx.db, "expenseCategories", ids);
    const grand = exp.facts.reduce((s, f) => s + f.cents, 0);

    const categoriesOut = ids
      .map((id, i) => ({
        categoryId: id,
        // A category deleted since would have no name; it cannot be deleted while used.
        name: categories[i]?.name ?? "Uncategorised",
        totalCents: totals.get(id)!.totalCents,
        count: totals.get(id)!.count,
        sharePct: percent(totals.get(id)!.totalCents, grand),
      }))
      .sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name));

    return {
      currency: base,
      totalCents: grand,
      categories: categoriesOut,
      excluded: { expenses: exp.excluded },
    };
  },
});

/** Money in (payments received) against money out (expenses), with a running net. */
export const cashFlow = scopedQuery({
  args: rangeArgs,
  handler: async (ctx, args) => {
    const base = await guard(ctx);
    const granularity = args.granularity ?? "month";
    const { from, to } = normalizeRange(args.from, args.to, granularity);

    const [pay, exp] = await Promise.all([
      paymentFacts(ctx, base, from, to),
      expenseFacts(ctx, base, from, to),
    ]);
    const { periods, byKey } = emptySeries(from, to, granularity, () => ({
      inCents: 0,
      outCents: 0,
      netCents: 0,
      cumulativeCents: 0,
    }));
    for (const f of pay.facts) {
      const row = byKey.get(periodKey(f.at, granularity));
      if (row) row.inCents += f.cents;
    }
    for (const f of exp.facts) {
      const row = byKey.get(periodKey(f.at, granularity));
      if (row) row.outCents += f.cents;
    }

    let running = 0;
    const series = periods.map((p) => {
      const row = byKey.get(p.key)!;
      row.netCents = row.inCents - row.outCents;
      running += row.netCents;
      row.cumulativeCents = running;
      return row;
    });

    return {
      currency: base,
      granularity,
      series,
      totals: {
        inCents: series.reduce((s, r) => s + r.inCents, 0),
        outCents: series.reduce((s, r) => s + r.outCents, 0),
        netCents: running,
      },
      excluded: { payments: pay.excluded, expenses: exp.excluded },
    };
  },
});
