import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { computeTotals, formatInvoiceNumber, startOfUtcDay } from "./lib/invoiceMath";
import { getEntitlements, getUsage, hasFeature } from "./lib/entitlements";
import { internalScopedMutation } from "./lib/functions";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { vPlanKey } from "./lib/validators";
import type { PlanKey } from "./lib/validators";

/**
 * Phase S — seed data. An internalMutation invoked via `npx convex run`, so
 * it is re-runnable against any scope (org or personal). Not idempotent by
 * design: re-running adds another batch, which is fine for a dev seed; use
 * `clearScope` first for a clean slate.
 *
 * Plan-aware: the dataset is shaped by what the scope's plan actually allows
 * (read from `subscriptions`, the same source every gate uses), never by what
 * the caller asks for. A Free scope gets Free-sized, base-currency data with
 * no recurring templates; only a Business scope gets foreign-currency clients.
 * Seeding data a plan can't use leaves that scope with records it can't edit.
 *
 * Uses `internalScopedMutation` (lib/functions.ts) rather than raw db
 * access so the same row-level security, audit, and counter/balance
 * triggers that govern real user writes also govern seeded ones — a seeded
 * invoice or payment updates client balances and usage counters exactly the
 * way a real one would.
 *
 *   npx convex run seed:clearScope '{"scopeId":"org_..."}'
 *   npx convex run seed:seedScope '{"scope":{"scopeId":"org_...","scopeKind":"org","userId":"user_...","role":"owner"},"expectPlan":"pro"}'
 */

const DAY_MS = 86_400_000;

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length - 1)];
}

const CLIENT_POOL = [
  { name: "Priya Sharma", company: "Northwind Retail" },
  { name: "Marcus Chen", company: "Chen & Fields Law" },
  { name: "Elena Rossi", company: "Rossi Design Studio" },
  { name: "Jamal Whitfield", company: "Whitfield Logistics" },
  { name: "Sofia Alvarez", company: "Alvarez Consulting" },
  { name: "Tom Bergström", company: "Bergström Interiors" },
  { name: "Aisha Bello", company: "Bello Media Group" },
  { name: "Ken Watanabe", company: "Watanabe Robotics" },
  { name: "Grace Okafor", company: "Okafor & Partners" },
  { name: "Liam O'Connell", company: "O'Connell Brewing Co." },
  { name: "Nadia Petrova", company: "Petrova Analytics" },
  { name: "Diego Fernández", company: "Fernández Imports" },
  { name: "Hannah Kim", company: "Kim Digital Studio" },
  { name: "Omar Haddad", company: "Haddad Construction" },
  { name: "Ingrid Larsen", company: "Larsen Textiles" },
  { name: "Victor Nguyen", company: "Nguyen Freight Solutions" },
  { name: "Chloe Dubois", company: "Dubois Atelier" },
  { name: "Ravi Patel", company: "Patel Health Systems" },
  { name: "Freya Johansson", company: "Johansson Renewables" },
  { name: "Miguel Santos", company: "Santos Hospitality Group" },
  { name: "Zoe Marshall", company: "Marshall & Co. Accounting" },
  { name: "Ahmed Farouk", company: "Farouk Trading" },
  { name: "Lena Schmidt", company: "Schmidt Engineering" },
  { name: "Isabella Conti", company: "Conti Fashion House" },
];

const SERVICE_POOL = [
  { desc: "Consulting — strategy engagement", unit: 15000 },
  { desc: "Monthly retainer", unit: 250000 },
  { desc: "Website redesign — phase delivery", unit: 420000 },
  { desc: "Brand identity package", unit: 65000 },
  { desc: "Support & maintenance (hourly)", unit: 9000 },
  { desc: "Content production — batch", unit: 32000 },
  { desc: "Software license renewal", unit: 18000 },
  { desc: "On-site training session", unit: 55000 },
  { desc: "Equipment rental", unit: 24000 },
  { desc: "Logistics coordination fee", unit: 12000 },
];

const EXPENSE_VENDORS: Record<string, string[]> = {
  Rent: ["Meridian Property Group"],
  Software: ["Vercel", "Figma", "Notion", "GitHub", "Adobe"],
  Travel: ["Delta Airlines", "Marriott", "Uber"],
  "Meals & Entertainment": ["The Corner Bistro", "Blue Bottle Coffee"],
  Utilities: ["Pacific Gas & Electric", "Comcast Business"],
  Marketing: ["Meta Ads", "Google Ads", "Mailchimp"],
  "Professional Services": ["Kessler & Vance LLP", "Anderson Bookkeeping"],
  Equipment: ["Best Buy Business", "B&H Photo"],
  Insurance: ["Hiscox", "The Hartford"],
  "Office Supplies": ["Staples", "Amazon Business"],
};

type Profile = {
  clientCount: number;
  invoiceCount: number;
  monthsOfHistory: number;
  expenseCount: number;
  recurringCount: number;
  extraCurrencies: { code: string; rate: number }[];
};

/** What a representative scope on each tier looks like (PLAN.md § Phase S). */
const PROFILES: Record<PlanKey, Profile> = {
  // Deliberately at the caps, so the quota walls show on first login.
  free: {
    clientCount: 5,
    invoiceCount: 10,
    monthsOfHistory: 3,
    expenseCount: 20,
    recurringCount: 0,
    extraCurrencies: [],
  },
  pro: {
    clientCount: 24,
    invoiceCount: 180,
    monthsOfHistory: 18,
    expenseCount: 120,
    recurringCount: 3,
    extraCurrencies: [],
  },
  business: {
    clientCount: 24,
    invoiceCount: 180,
    monthsOfHistory: 18,
    expenseCount: 120,
    recurringCount: 3,
    // Rate converts one unit of the invoice currency into the (USD) base.
    extraCurrencies: [
      { code: "EUR", rate: 1.08 },
      { code: "GBP", rate: 1.27 },
      { code: "CAD", rate: 0.73 },
    ],
  },
};

type LineDraft ={ description: string; quantity: number; unitPriceCents: number; taxRatePct: number };

function draftLines(): LineDraft[] {
  const count = randomInt(1, 3);
  return Array.from({ length: count }, () => {
    const svc = pick(SERVICE_POOL);
    return {
      description: svc.desc,
      quantity: randomInt(1, 3),
      unitPriceCents: svc.unit,
      taxRatePct: 0,
    };
  });
}

export const seedScope = internalScopedMutation({
  args: {
    /** Refuse to seed unless the scope resolves to this plan (catches an unsynced subscription). */
    expectPlan: v.optional(vPlanKey),
    // Overrides of the plan's profile. Each is clamped to what the plan allows.
    clientCount: v.optional(v.number()),
    invoiceCount: v.optional(v.number()),
    monthsOfHistory: v.optional(v.number()),
    expenseCount: v.optional(v.number()),
    recurringCount: v.optional(v.number()),
    /** Foreign currencies for some clients. Ignored unless the plan has `multi_currency`. */
    extraCurrencies: v.optional(v.array(v.object({ code: v.string(), rate: v.number() }))),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const entitlements = await getEntitlements(ctx);
    const plan = entitlements.planKey;
    if (args.expectPlan !== undefined && args.expectPlan !== plan) {
      throw new Error(
        `Scope ${ctx.scope.scopeId} resolves to the "${plan}" plan, not "${args.expectPlan}". ` +
          `Subscribe it in Clerk and let the webhook sync the subscription first.`,
      );
    }
    const profile = PROFILES[plan];
    const canMultiCurrency = hasFeature(entitlements, "multi_currency");
    const canRecurring = hasFeature(entitlements, "recurring_invoices");

    // Clamp to what is left under the plan's caps: seeding past a cap would
    // be refused by the RLS quota rule anyway, rolling back the whole run.
    const [clientsUsed, invoicesUsed] = await Promise.all([
      getUsage(ctx, "clients", now),
      getUsage(ctx, "invoices", now),
    ]);
    const clientCount = Math.max(
      0,
      Math.min(args.clientCount ?? profile.clientCount, entitlements.clients - clientsUsed, CLIENT_POOL.length),
    );
    const invoiceCount = Math.max(
      0,
      Math.min(args.invoiceCount ?? profile.invoiceCount, entitlements.invoicesPerMonth - invoicesUsed),
    );
    const monthsOfHistory = Math.max(1, args.monthsOfHistory ?? profile.monthsOfHistory);
    const expenseCount = Math.max(0, args.expenseCount ?? profile.expenseCount);
    const recurringCount = canRecurring ? Math.max(0, args.recurringCount ?? profile.recurringCount) : 0;
    const extraCurrencies = canMultiCurrency ? (args.extraCurrencies ?? profile.extraCurrencies) : [];
    // The invoice quota is monthly and counted by creation time, so a capped
    // plan's whole budget lands in the current month; issue dates follow.
    const thisMonthOnly = Number.isFinite(entitlements.invoicesPerMonth);

    const settings = await ctx.db
      .query("scopeSettings")
      .withIndex("by_scopeId", (q) => q.eq("scopeId", ctx.scope.scopeId))
      .first();
    if (!settings) {
      throw new Error(
        `No scopeSettings for ${ctx.scope.scopeId} — sync the org/user first (see docs/clerk-setup.md).`,
      );
    }
    const categories = await ctx.db
      .query("expenseCategories")
      .withIndex("by_scopeId_and_name", (q) => q.eq("scopeId", ctx.scope.scopeId))
      .collect();
    if (categories.length === 0) {
      throw new Error(`No expense categories for ${ctx.scope.scopeId} — sync it first.`);
    }

    let seq = settings.nextInvoiceSeq;
    const baseCurrency = settings.currency;

    // --- Clients -------------------------------------------------------------
    const shuffled = [...CLIENT_POOL].sort(() => Math.random() - 0.5).slice(0, clientCount);
    const clientIds: Id<"clients">[] = [];
    for (const c of shuffled) {
      const useExtra = extraCurrencies.length > 0 && Math.random() < 0.3;
      const currency = useExtra ? pick(extraCurrencies).code : baseCurrency;
      const id = await ctx.db.insert("clients", {
        scopeId: ctx.scope.scopeId,
        scopeKind: ctx.scope.scopeKind,
        name: c.name,
        company: c.company,
        email: `${c.name.toLowerCase().replace(/[^a-z]+/g, ".")}@${c.company.toLowerCase().replace(/[^a-z]+/g, "")}.example`,
        currency,
        isArchived: false,
        outstandingCents: 0,
        totalBilledCents: 0,
        totalPaidCents: 0,
      });
      clientIds.push(id);
    }

    // A capped scope may already be at its client limit; invoice the clients
    // it has (only ones its plan can invoice) rather than seed none.
    if (clientIds.length === 0 && invoiceCount + recurringCount > 0) {
      const existing = await ctx.db
        .query("clients")
        .withIndex("by_scopeId_and_isArchived", (q) =>
          q.eq("scopeId", ctx.scope.scopeId).eq("isArchived", false),
        )
        .take(100);
      for (const c of existing) {
        if (canMultiCurrency || c.currency === baseCurrency) clientIds.push(c._id);
      }
    }
    const totalInvoices = clientIds.length > 0 ? invoiceCount : 0;
    const today = new Date(now).getUTCDate();

    // --- Invoices + payments ---------------------------------------------------
    for (let i = 0; i < totalInvoices; i++) {
      const clientId = pick(clientIds);
      const client = (await ctx.db.get("clients", clientId))!;

      const monthsBack = thisMonthOnly ? 0 : randomInt(0, monthsOfHistory - 1);
      // Never issue in the future: the current month only runs up to today.
      const dayOffset = randomInt(1, monthsBack === 0 ? Math.min(27, today) : 27);
      const issueDate = startOfUtcDay(
        Date.UTC(
          new Date(now).getUTCFullYear(),
          new Date(now).getUTCMonth() - monthsBack,
          dayOffset,
        ),
      );
      const dueDate = startOfUtcDay(issueDate + settings.paymentTermsDays * DAY_MS);

      const lines = draftLines();
      const totals = computeTotals(lines);

      const currency = client.currency;
      const exchangeRate =
        currency !== baseCurrency ? extraCurrencies.find((c) => c.code === currency)?.rate : undefined;

      // Status distribution: older invoices skew paid; the most recent batch
      // is where drafts/sent/overdue actually make sense.
      const ageDays = (now - issueDate) / DAY_MS;
      let status: "draft" | "sent" | "viewed" | "paid" | "overdue" | "void";
      let paidAt: number | undefined;
      let sentAt: number | undefined;
      let viewedAt: number | undefined;
      const roll = Math.random();
      if (ageDays < 3) {
        status = roll < 0.3 ? "draft" : roll < 0.7 ? "sent" : "viewed";
        if (status !== "draft") sentAt = issueDate + DAY_MS;
        if (status === "viewed") viewedAt = sentAt! + DAY_MS;
      } else if (dueDate < now && roll < 0.15) {
        status = "overdue";
        sentAt = issueDate + DAY_MS;
        viewedAt = sentAt + DAY_MS;
      } else if (roll < 0.05) {
        status = "void";
        sentAt = issueDate + DAY_MS;
      } else {
        status = "paid";
        sentAt = issueDate + DAY_MS;
        viewedAt = sentAt + DAY_MS;
        paidAt = Math.min(dueDate, viewedAt + randomInt(1, 6) * DAY_MS);
      }

      const invoiceId = await ctx.db.insert("invoices", {
        scopeId: ctx.scope.scopeId,
        scopeKind: ctx.scope.scopeKind,
        clientId,
        invoiceNumber: formatInvoiceNumber(settings.invoiceNumberPrefix, seq++),
        status,
        issueDate,
        dueDate,
        currency,
        exchangeRate,
        subtotalCents: totals.subtotalCents,
        taxCents: totals.taxCents,
        discountCents: totals.discountCents,
        totalCents: totals.totalCents,
        paidCents: 0,
        publicToken: status === "draft" ? undefined : crypto.randomUUID().replace(/-/g, ""),
        sentAt,
        viewedAt,
        paidAt,
      });

      for (const line of totals.lines) {
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

      if (status === "paid") {
        // Most pay in full; a few carry a partial payment for realism.
        const partial = Math.random() < 0.12;
        await ctx.db.insert("payments", {
          scopeId: ctx.scope.scopeId,
          scopeKind: ctx.scope.scopeKind,
          invoiceId,
          clientId,
          amountCents: partial ? Math.round(totals.totalCents * 0.6) : totals.totalCents,
          paidAt: paidAt!,
          method: pick(["bank_transfer", "card", "check"]),
        });
        if (partial) {
          // Second, smaller payment a few days later closes it out.
          await ctx.db.insert("payments", {
            scopeId: ctx.scope.scopeId,
            scopeKind: ctx.scope.scopeKind,
            invoiceId,
            clientId,
            amountCents: totals.totalCents - Math.round(totals.totalCents * 0.6),
            paidAt: paidAt! + 2 * DAY_MS,
            method: "bank_transfer",
          });
        }
      }
    }
    await ctx.db.patch("scopeSettings", settings._id, { nextInvoiceSeq: seq });

    // --- Expenses --------------------------------------------------------------
    for (let i = 0; i < expenseCount; i++) {
      const category = pick(categories);
      const vendors = EXPENSE_VENDORS[category.name] ?? ["General Vendor Co."];
      const monthsBack = randomInt(0, monthsOfHistory - 1);
      const day = randomInt(1, monthsBack === 0 ? Math.min(27, today) : 27);
      const spentAt = startOfUtcDay(
        Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - monthsBack, day),
      );
      const amountCents = randomInt(1500, 180000);
      await ctx.db.insert("expenses", {
        scopeId: ctx.scope.scopeId,
        scopeKind: ctx.scope.scopeKind,
        categoryId: category._id,
        vendor: pick(vendors),
        amountCents,
        taxCents: Math.round(amountCents * 0.0),
        currency: baseCurrency,
        spentAt,
        paymentMethod: pick(["card", "bank_transfer", "cash"]),
        ocrStatus: "none",
        isBillable: Math.random() < 0.15,
      });
    }

    // --- Recurring templates (plans with `recurring_invoices` only) ------------
    const recurringSeeded = clientIds.length > 0 ? recurringCount : 0;
    for (let i = 0; i < recurringSeeded; i++) {
      const clientId = pick(clientIds);
      const client = (await ctx.db.get("clients", clientId))!;
      const lines = draftLines();
      const startDate = startOfUtcDay(now - randomInt(30, 120) * DAY_MS);
      const recurringId = await ctx.db.insert("recurringInvoices", {
        scopeId: ctx.scope.scopeId,
        scopeKind: ctx.scope.scopeKind,
        clientId,
        frequency: pick(["monthly", "quarterly"] as const),
        startDate,
        nextRunAt: startOfUtcDay(now + randomInt(3, 20) * DAY_MS),
        isActive: true,
        currency: client.currency,
        paymentTermsDays: settings.paymentTermsDays,
        discountCents: 0,
      });
      for (const [position, line] of lines.entries()) {
        await ctx.db.insert("recurringLineItems", {
          scopeId: ctx.scope.scopeId,
          scopeKind: ctx.scope.scopeKind,
          recurringInvoiceId: recurringId,
          position,
          description: line.description,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          taxRatePct: line.taxRatePct,
        });
      }
    }

    return {
      plan,
      clients: shuffled.length,
      invoices: totalInvoices,
      expenses: expenseCount,
      recurring: recurringSeeded,
      currencies: [baseCurrency, ...extraCurrencies.map((c) => c.code)],
    };
  },
});

// --- Reset -------------------------------------------------------------------

/** Per call; the rest continues in a scheduled follow-up transaction. */
const CLEAR_BUDGET = 2000;

/** Reads up to `n` of one table's rows for a scope and deletes them. */
type Wipe = (ctx: MutationCtx, scopeId: string, n: number) => Promise<number>;

async function wipe<T extends TableNames>(ctx: MutationCtx, table: T, rows: Doc<T>[]) {
  for (const row of rows) await ctx.db.delete(table, row._id);
  return rows.length;
}

// Every per-scope table the seed (or real use) writes, each read by an index
// that starts with `scopeId`. Settings, categories, memberships and
// subscriptions are kept: they come from the Clerk sync, not from seeding.
const CLEARABLE: Wipe[] = [
  async (ctx, s, n) =>
    wipe(ctx, "payments", await ctx.db.query("payments").withIndex("by_scopeId_and_invoiceId", (q) => q.eq("scopeId", s)).take(n)),
  async (ctx, s, n) =>
    wipe(ctx, "invoiceLineItems", await ctx.db.query("invoiceLineItems").withIndex("by_scopeId_and_invoiceId_and_position", (q) => q.eq("scopeId", s)).take(n)),
  async (ctx, s, n) =>
    wipe(ctx, "invoices", await ctx.db.query("invoices").withIndex("by_scopeId_and_issueDate", (q) => q.eq("scopeId", s)).take(n)),
  async (ctx, s, n) =>
    wipe(ctx, "recurringLineItems", await ctx.db.query("recurringLineItems").withIndex("by_scopeId_and_recurringInvoiceId_and_position", (q) => q.eq("scopeId", s)).take(n)),
  async (ctx, s, n) =>
    wipe(ctx, "recurringInvoices", await ctx.db.query("recurringInvoices").withIndex("by_scopeId_and_clientId", (q) => q.eq("scopeId", s)).take(n)),
  async (ctx, s, n) => {
    const rows = await ctx.db.query("expenses").withIndex("by_scopeId_and_spentAt", (q) => q.eq("scopeId", s)).take(n);
    for (const row of rows) if (row.receiptStorageId) await ctx.storage.delete(row.receiptStorageId);
    return wipe(ctx, "expenses", rows);
  },
  async (ctx, s, n) =>
    wipe(ctx, "clients", await ctx.db.query("clients").withIndex("by_scopeId_and_isArchived", (q) => q.eq("scopeId", s)).take(n)),
  async (ctx, s, n) =>
    wipe(ctx, "usageCounters", await ctx.db.query("usageCounters").withIndex("by_scopeId_and_metric_and_period", (q) => q.eq("scopeId", s)).take(n)),
  async (ctx, s, n) =>
    wipe(ctx, "auditLogs", await ctx.db.query("auditLogs").withIndex("by_scopeId", (q) => q.eq("scopeId", s)).take(n)),
];

/**
 * Dev-only: wipes a scope's books so it can be reseeded for its plan. Raw db
 * on purpose — the counter and balance triggers would only be fighting a
 * wipe that deletes the counters and balances outright.
 */
export const clearScope = internalMutation({
  args: { scopeId: v.string() },
  handler: async (ctx, { scopeId }) => {
    let deleted = 0;
    for (const clear of CLEARABLE) {
      deleted += await clear(ctx, scopeId, CLEAR_BUDGET - deleted);
      if (deleted >= CLEAR_BUDGET) {
        await ctx.scheduler.runAfter(0, internal.seed.clearScope, { scopeId });
        return { deleted, continuing: true };
      }
    }
    const settings = await ctx.db
      .query("scopeSettings")
      .withIndex("by_scopeId", (q) => q.eq("scopeId", scopeId))
      .first();
    if (settings) await ctx.db.patch("scopeSettings", settings._id, { nextInvoiceSeq: 1 });
    return { deleted, continuing: false };
  },
});
