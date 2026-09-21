/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DAY_MS } from "./lib/dates";
import type { PlanKey } from "./lib/validators";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://example.clerk.accounts.dev";

function identity(userId: string, org?: { id: string; rol: string }) {
  return {
    issuer: ISSUER,
    subject: userId,
    tokenIdentifier: `${ISSUER}|${userId}`,
    ...(org ? { o: { id: org.id, rol: org.rol, slg: "slug" } } : {}),
  };
}
function setup() {
  const t = convexTest(schema, modules);
  return {
    t,
    owner: t.withIdentity(identity("user_alice", { id: "org_A", rol: "owner" })),
    viewer: t.withIdentity(identity("user_view", { id: "org_A", rol: "member" })),
    bob: t.withIdentity(identity("user_bob", { id: "org_B", rol: "owner" })),
    personal: t.withIdentity(identity("user_alice")),
  };
}
type Ctx = ReturnType<typeof setup>;

let itemSeq = 0;
const subscribe = (
  t: Ctx["t"],
  scopeId: string,
  planKey: PlanKey,
  status = "active",
  scopeKind: "org" | "user" = "org",
) =>
  t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      scopeId,
      scopeKind,
      planKey,
      clerkPlanSlug: `${planKey}_${scopeKind}`,
      clerkSubscriptionItemId: `subi_${++itemSeq}`,
      status,
      features: [],
    }),
  );

/** UTC date helper. */
const d = (y: number, m: number, day = 1, h = 0, min = 0, s = 0, ms = 0) =>
  Date.UTC(y, m - 1, day, h, min, s, ms);

// --- Raw fixtures: reports are tested independently of the write paths ------

let clientId: Id<"clients">;
const client = (t: Ctx["t"], scopeId = "org_A") =>
  t.run((ctx) =>
    ctx.db.insert("clients", {
      scopeId,
      scopeKind: scopeId.startsWith("org") ? "org" : "user",
      name: "Acme",
      currency: "USD",
      isArchived: false,
      outstandingCents: 0,
      totalBilledCents: 0,
      totalPaidCents: 0,
    }),
  );

let invSeq = 0;
async function invoice(
  t: Ctx["t"],
  over: Partial<{
    scopeId: string;
    status: "draft" | "sent" | "viewed" | "paid" | "overdue" | "void";
    issueDate: number;
    dueDate: number;
    currency: string;
    exchangeRate: number;
    totalCents: number;
    taxCents: number;
    paidCents: number;
  }> = {},
) {
  const scopeId = over.scopeId ?? "org_A";
  const cid = scopeId === "org_A" ? (clientId ??= await client(t)) : await client(t, scopeId);
  const totalCents = over.totalCents ?? 10_000;
  const taxCents = over.taxCents ?? 0;
  return await t.run((ctx) =>
    ctx.db.insert("invoices", {
      scopeId,
      scopeKind: scopeId.startsWith("org") ? "org" : "user",
      clientId: cid,
      invoiceNumber: `INV-${++invSeq}`,
      status: over.status ?? "sent",
      issueDate: over.issueDate ?? d(2026, 1, 10),
      dueDate: over.dueDate ?? d(2026, 2, 10),
      currency: over.currency ?? "USD",
      exchangeRate: over.exchangeRate,
      subtotalCents: totalCents - taxCents,
      taxCents,
      discountCents: 0,
      totalCents,
      paidCents: over.paidCents ?? 0,
    }),
  );
}

const payment = (t: Ctx["t"], invoiceId: Id<"invoices">, amountCents: number, paidAt: number, scopeId = "org_A") =>
  t.run(async (ctx) => {
    const inv = await ctx.db.get("invoices", invoiceId);
    return ctx.db.insert("payments", {
      scopeId,
      scopeKind: scopeId.startsWith("org") ? "org" : "user",
      invoiceId,
      clientId: inv!.clientId,
      amountCents,
      paidAt,
      method: "bank_transfer",
    });
  });

const category = (t: Ctx["t"], name: string, scopeId = "org_A") =>
  t.run((ctx) =>
    ctx.db.insert("expenseCategories", {
      scopeId,
      scopeKind: scopeId.startsWith("org") ? "org" : "user",
      name,
      isDefault: false,
    }),
  );

const expense = (
  t: Ctx["t"],
  categoryId: Id<"expenseCategories">,
  amountCents: number,
  spentAt: number,
  over: Partial<{ taxCents: number; currency: string; scopeId: string }> = {},
) =>
  t.run((ctx) =>
    ctx.db.insert("expenses", {
      scopeId: over.scopeId ?? "org_A",
      scopeKind: "org",
      categoryId,
      vendor: "Vendor",
      amountCents,
      taxCents: over.taxCents ?? 0,
      currency: over.currency ?? "USD",
      spentAt,
      paymentMethod: "card",
      ocrStatus: "none",
      isBillable: false,
    }),
  );

const Q1 = { from: d(2026, 1, 1), to: d(2026, 3, 31) };

// --- Gating ---------------------------------------------------------------------

describe("gating", () => {
  const calls = (actor: Ctx["owner"]) => [
    () => actor.query(api.reports.revenue, Q1),
    () => actor.query(api.reports.receivables, { ...Q1, asOf: d(2026, 3, 31) }),
    () => actor.query(api.reports.profitAndLoss, Q1),
    () => actor.query(api.reports.expenseBreakdown, Q1),
    () => actor.query(api.reports.cashFlow, Q1),
  ];

  test("every report is refused on Free, naming the plan that unlocks it", async () => {
    const { owner } = setup();
    for (const call of calls(owner)) {
      await expect(call()).rejects.toMatchObject({
        data: { code: "UPGRADE_REQUIRED", reason: "feature", feature: "reports", currentPlan: "free", requiredPlan: "pro" },
      });
    }
  });

  test("every report works on Pro, even with no data", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    for (const call of calls(owner)) await expect(call()).resolves.toBeDefined();
  });

  test("a lapsed plan loses access again", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro", "past_due");
    await expect(owner.query(api.reports.revenue, Q1)).rejects.toMatchObject({
      data: { code: "UPGRADE_REQUIRED" },
    });
  });

  test("a viewer may read reports once the plan allows it", async () => {
    const { t, viewer } = setup();
    await subscribe(t, "org_A", "pro");
    for (const call of calls(viewer)) await expect(call()).resolves.toBeDefined();
  });

  test("a personal workspace can upgrade on its own", async () => {
    const { t, personal } = setup();
    await expect(personal.query(api.reports.revenue, Q1)).rejects.toThrow();
    await subscribe(t, "user_alice", "pro", "active", "user");
    await expect(personal.query(api.reports.revenue, Q1)).resolves.toBeDefined();
  });

  test("every report needs a signed-in caller", async () => {
    const { t } = setup();
    for (const call of calls(t as never)) {
      await expect(call()).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
    }
  });

  test("bad ranges are refused with a typed error", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    await expect(
      owner.query(api.reports.revenue, { from: d(2026, 3, 2), to: d(2026, 3, 1) }),
    ).rejects.toMatchObject({ data: { code: "INVALID_INPUT", field: "to" } });
    await expect(
      owner.query(api.reports.revenue, { from: Number.NaN, to: d(2026, 3, 1) }),
    ).rejects.toMatchObject({ data: { field: "from" } });
    await expect(
      owner.query(api.reports.revenue, { from: d(1990, 1, 1), to: d(2026, 1, 1) }),
    ).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
  });
});

// --- Revenue --------------------------------------------------------------------

describe("revenue", () => {
  async function seed(t: Ctx["t"]) {
    await subscribe(t, "org_A", "pro");
    const jan1 = await invoice(t, { issueDate: d(2026, 1, 10), totalCents: 10_000 });
    await invoice(t, { issueDate: d(2026, 1, 20), totalCents: 5_000 });
    const feb = await invoice(t, { status: "paid", issueDate: d(2026, 2, 5), totalCents: 20_000, paidCents: 20_000 });
    await invoice(t, { status: "draft", issueDate: d(2026, 3, 1), totalCents: 99_999 });
    await invoice(t, { status: "void", issueDate: d(2026, 3, 2), totalCents: 88_888 });
    await payment(t, jan1, 4_000, d(2026, 1, 15, 11));
    await payment(t, feb, 20_000, d(2026, 2, 10, 9));
  }

  test("billed and collected per month, zero-filled, excluding drafts and voids", async () => {
    const { t, owner } = setup();
    await seed(t);
    const r = await owner.query(api.reports.revenue, Q1);
    expect(r.currency).toBe("USD");
    expect(r.series.map((s) => [s.period, s.invoicedCents, s.collectedCents, s.invoiceCount])).toEqual([
      ["2026-01", 15_000, 4_000, 2],
      ["2026-02", 20_000, 20_000, 1],
      ["2026-03", 0, 0, 0],
    ]);
    expect(r.totals).toEqual({ invoicedCents: 35_000, collectedCents: 24_000, invoiceCount: 3 });
  });

  test("groups by quarter and year, filling quiet periods", async () => {
    const { t, owner } = setup();
    await seed(t);
    const q = await owner.query(api.reports.revenue, {
      from: d(2026, 1, 1),
      to: d(2026, 9, 30),
      granularity: "quarter",
    });
    expect(q.series.map((s) => [s.period, s.invoicedCents])).toEqual([
      ["2026-Q1", 35_000],
      ["2026-Q2", 0],
      ["2026-Q3", 0],
    ]);

    await invoice(t, { issueDate: d(2025, 6, 1), totalCents: 1_000 });
    const y = await owner.query(api.reports.revenue, {
      from: d(2025, 1, 1),
      to: d(2026, 12, 31),
      granularity: "year",
    });
    expect(y.series.map((s) => [s.period, s.invoicedCents])).toEqual([
      ["2025", 1_000],
      ["2026", 35_000],
    ]);
  });

  test("period edges are exact: the last millisecond of January is January", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const a = await invoice(t, { issueDate: d(2026, 1, 31), totalCents: 100 });
    await invoice(t, { issueDate: d(2026, 2, 1), totalCents: 200 });
    await payment(t, a, 10, d(2026, 1, 31, 23, 59, 59, 999));
    await payment(t, a, 20, d(2026, 2, 1, 0, 0, 0, 0));

    const r = await owner.query(api.reports.revenue, { from: d(2026, 1, 1), to: d(2026, 2, 28) });
    expect(r.series.map((s) => [s.period, s.invoicedCents, s.collectedCents])).toEqual([
      ["2026-01", 100, 10],
      ["2026-02", 200, 20],
    ]);
  });

  test("the range includes all of its last day, so a mid-afternoon payment counts", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const inv = await invoice(t, { issueDate: d(2026, 3, 31), totalCents: 500 });
    await payment(t, inv, 300, d(2026, 3, 31, 15, 0));
    const r = await owner.query(api.reports.revenue, Q1);
    expect(r.totals).toMatchObject({ invoicedCents: 500, collectedCents: 300 });
  });

  test("anything outside the range is left out", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    await invoice(t, { issueDate: d(2025, 12, 31), totalCents: 111 });
    await invoice(t, { issueDate: d(2026, 4, 1), totalCents: 222 });
    const r = await owner.query(api.reports.revenue, Q1);
    expect(r.totals.invoicedCents).toBe(0);
  });

  test("converts foreign invoices with their exchange rate, payments included", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "business");
    const eur = await invoice(t, { currency: "EUR", exchangeRate: 1.1, totalCents: 10_000 });
    await payment(t, eur, 4_000, d(2026, 1, 20));
    const r = await owner.query(api.reports.revenue, Q1);
    expect(r.totals).toMatchObject({ invoicedCents: 11_000, collectedCents: 4_400 });
    expect(r.excluded).toEqual({ invoices: 0, payments: 0 });
  });

  test("a foreign invoice with no rate, and a payment with no invoice, are counted, not summed", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const noRate = await invoice(t, { currency: "EUR", totalCents: 10_000 });
    await payment(t, noRate, 4_000, d(2026, 1, 20));
    const r = await owner.query(api.reports.revenue, Q1);
    expect(r.totals).toMatchObject({ invoicedCents: 0, collectedCents: 0 });
    expect(r.excluded).toEqual({ invoices: 1, payments: 1 });
  });

  test("never includes another scope's figures", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    await invoice(t, { scopeId: "org_B", totalCents: 77_777 });
    await invoice(t, { totalCents: 1_000 });
    expect((await owner.query(api.reports.revenue, Q1)).totals.invoicedCents).toBe(1_000);
  });
});

// --- Receivables ------------------------------------------------------------------

describe("receivables", () => {
  const asOf = d(2026, 9, 21, 12);
  const daysAgo = (n: number) => d(2026, 9, 21) - n * DAY_MS;

  async function seed(t: Ctx["t"]) {
    await subscribe(t, "org_A", "pro");
    await invoice(t, { status: "sent", dueDate: daysAgo(-10), totalCents: 10_000 }); // current
    await invoice(t, { status: "sent", dueDate: daysAgo(0), totalCents: 1_000 }); // due today: current
    await invoice(t, { status: "viewed", dueDate: daysAgo(10), totalCents: 8_000, paidCents: 3_000 }); // 5,000 owed, 1-30
    await invoice(t, { status: "overdue", dueDate: daysAgo(45), totalCents: 7_000 }); // 31-60
    await invoice(t, { status: "overdue", dueDate: daysAgo(100), totalCents: 2_000, paidCents: 500 }); // 1,500 owed, 90+
    // None of these are receivable.
    await invoice(t, { status: "paid", dueDate: daysAgo(50), totalCents: 9_999, paidCents: 9_999 });
    await invoice(t, { status: "draft", dueDate: daysAgo(50), totalCents: 9_999 });
    await invoice(t, { status: "void", dueDate: daysAgo(50), totalCents: 9_999 });
  }

  test("outstanding is every open invoice's balance, aged by how far past due", async () => {
    const { t, owner } = setup();
    await seed(t);
    const r = await owner.query(api.reports.receivables, { ...Q1, asOf });
    expect(r.outstanding.totalCents).toBe(10_000 + 1_000 + 5_000 + 7_000 + 1_500);
    expect(r.outstanding.openCount).toBe(5);
    expect(r.outstanding.aging).toEqual([
      { bucket: "current", cents: 11_000, count: 2 },
      { bucket: "1-30", cents: 5_000, count: 1 },
      { bucket: "31-60", cents: 7_000, count: 1 },
      { bucket: "61-90", cents: 0, count: 0 },
      { bucket: "90+", cents: 1_500, count: 1 },
    ]);
  });

  test("overdue is whatever is past its due day as of the date given", async () => {
    const { t, owner } = setup();
    await seed(t);
    const r = await owner.query(api.reports.receivables, { ...Q1, asOf });
    expect(r.outstanding).toMatchObject({ overdueCents: 5_000 + 7_000 + 1_500, overdueCount: 3 });

    // A month earlier, the invoice that is 10 days past due today was not yet
    // due; only the two oldest were (then 15 and 70 days past due).
    const earlier = await owner.query(api.reports.receivables, { ...Q1, asOf: daysAgo(30) });
    expect(earlier.outstanding.overdueCount).toBe(2);
  });

  test("billed and collected over the range, and the collection rate", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const a = await invoice(t, { issueDate: d(2026, 2, 1), totalCents: 20_000 });
    await payment(t, a, 5_000, d(2026, 2, 15));
    const r = await owner.query(api.reports.receivables, { ...Q1, asOf });
    expect(r.range).toEqual({ invoicedCents: 20_000, collectedCents: 5_000, collectionRatePct: 25 });
  });

  test("with nothing billed the collection rate is null, not zero or NaN", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const r = await owner.query(api.reports.receivables, { ...Q1, asOf });
    expect(r.range.collectionRatePct).toBeNull();
    expect(r.outstanding).toMatchObject({ totalCents: 0, openCount: 0 });
  });

  test("converts foreign balances, and counts an open invoice it cannot convert", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "business");
    await invoice(t, { currency: "EUR", exchangeRate: 2, dueDate: daysAgo(-5), totalCents: 1_000, paidCents: 200 });
    await invoice(t, { currency: "GBP", dueDate: daysAgo(-5), totalCents: 5_000 });
    const r = await owner.query(api.reports.receivables, { ...Q1, asOf });
    expect(r.outstanding.totalCents).toBe(1_600); // (1,000 - 200) * 2
    expect(r.excluded.openInvoices).toBe(1);
  });

  test("open invoices from other scopes are not counted", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    await invoice(t, { scopeId: "org_B", status: "overdue", dueDate: daysAgo(50), totalCents: 50_000 });
    const r = await owner.query(api.reports.receivables, { ...Q1, asOf });
    expect(r.outstanding.totalCents).toBe(0);
  });
});

// --- Profit and loss --------------------------------------------------------------

describe("profitAndLoss", () => {
  async function seed(t: Ctx["t"]) {
    await subscribe(t, "org_A", "pro");
    // 11,000 gross with 1,000 tax = 10,000 revenue; 6,600 with 600 = 6,000.
    await invoice(t, { issueDate: d(2026, 1, 10), totalCents: 11_000, taxCents: 1_000 });
    await invoice(t, { issueDate: d(2026, 2, 10), totalCents: 6_600, taxCents: 600, status: "paid", paidCents: 6_600 });
    await invoice(t, { issueDate: d(2026, 2, 12), status: "draft", totalCents: 50_000 });
    await invoice(t, { issueDate: d(2026, 2, 13), status: "void", totalCents: 50_000 });
    const rent = await category(t, "Rent");
    await expense(t, rent, 4_000, d(2026, 1, 5), { taxCents: 400 });
    await expense(t, rent, 1_000, d(2026, 3, 5));
  }

  test("revenue is net of sales tax; profit is revenue less expenses", async () => {
    const { t, owner } = setup();
    await seed(t);
    const r = await owner.query(api.reports.profitAndLoss, Q1);
    expect(r).toMatchObject({
      currency: "USD",
      revenueCents: 16_000,
      expensesCents: 5_000,
      netProfitCents: 11_000,
      marginPct: 68.8,
      salesTaxCents: 1_600,
      expenseTaxCents: 400,
      invoiceCount: 2,
      expenseCount: 2,
    });
  });

  test("the series lines up by period", async () => {
    const { t, owner } = setup();
    await seed(t);
    const r = await owner.query(api.reports.profitAndLoss, Q1);
    expect(r.series.map((s) => [s.period, s.revenueCents, s.expensesCents, s.netProfitCents])).toEqual([
      ["2026-01", 10_000, 4_000, 6_000],
      ["2026-02", 6_000, 0, 6_000],
      ["2026-03", 0, 1_000, -1_000],
    ]);
  });

  test("a loss is negative, and with no revenue the margin is null", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const cat = await category(t, "Software");
    await expense(t, cat, 2_500, d(2026, 2, 1));
    const r = await owner.query(api.reports.profitAndLoss, Q1);
    expect(r).toMatchObject({ revenueCents: 0, expensesCents: 2_500, netProfitCents: -2_500, marginPct: null });
  });

  test("an expense in another currency cannot be converted, so it is counted and left out", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "business");
    const cat = await category(t, "Travel");
    await expense(t, cat, 1_000, d(2026, 1, 5));
    await expense(t, cat, 9_999, d(2026, 1, 6), { currency: "EUR" });
    const r = await owner.query(api.reports.profitAndLoss, Q1);
    expect(r.expensesCents).toBe(1_000);
    expect(r.excluded.expenses).toBe(1);
  });

  test("converts a foreign invoice's revenue with its rate", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "business");
    await invoice(t, { currency: "EUR", exchangeRate: 1.5, totalCents: 1_200, taxCents: 200 });
    expect((await owner.query(api.reports.profitAndLoss, Q1)).revenueCents).toBe(1_500); // (1,200 - 200) * 1.5
  });

  test("quarterly grouping", async () => {
    const { t, owner } = setup();
    await seed(t);
    const r = await owner.query(api.reports.profitAndLoss, { ...Q1, granularity: "quarter" });
    expect(r.series).toHaveLength(1);
    expect(r.series[0]).toMatchObject({ period: "2026-Q1", revenueCents: 16_000, expensesCents: 5_000 });
  });

  test("other scopes' invoices and expenses are not mixed in", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    await invoice(t, { scopeId: "org_B", totalCents: 99_000 });
    const theirs = await category(t, "Theirs", "org_B");
    await expense(t, theirs, 88_000, d(2026, 1, 5), { scopeId: "org_B" });
    const r = await owner.query(api.reports.profitAndLoss, Q1);
    expect(r).toMatchObject({ revenueCents: 0, expensesCents: 0 });
  });
});

// --- Expense breakdown ---------------------------------------------------------------

describe("expenseBreakdown", () => {
  test("totals per category, largest first, with each one's share", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const rent = await category(t, "Rent");
    const software = await category(t, "Software");
    const travel = await category(t, "Travel");
    await expense(t, rent, 6_000, d(2026, 1, 1));
    await expense(t, software, 1_000, d(2026, 1, 2));
    await expense(t, software, 2_000, d(2026, 2, 2));
    await expense(t, travel, 1_000, d(2026, 3, 2));

    const r = await owner.query(api.reports.expenseBreakdown, Q1);
    expect(r.totalCents).toBe(10_000);
    expect(r.categories.map((c) => [c.name, c.totalCents, c.count, c.sharePct])).toEqual([
      ["Rent", 6_000, 1, 60],
      ["Software", 3_000, 2, 30],
      ["Travel", 1_000, 1, 10],
    ]);
  });

  test("ties are ordered by name so the result is stable", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const b = await category(t, "Bravo");
    const a = await category(t, "Alpha");
    await expense(t, b, 500, d(2026, 1, 1));
    await expense(t, a, 500, d(2026, 1, 1));
    const r = await owner.query(api.reports.expenseBreakdown, Q1);
    expect(r.categories.map((c) => c.name)).toEqual(["Alpha", "Bravo"]);
  });

  test("respects the range, leaves out other currencies, and is empty when nothing matches", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "business");
    const cat = await category(t, "Rent");
    await expense(t, cat, 1_000, d(2025, 12, 31));
    await expense(t, cat, 2_000, d(2026, 1, 1));
    await expense(t, cat, 3_000, d(2026, 4, 1));
    await expense(t, cat, 4_000, d(2026, 2, 1), { currency: "EUR" });

    const r = await owner.query(api.reports.expenseBreakdown, Q1);
    expect(r.categories).toMatchObject([{ name: "Rent", totalCents: 2_000 }]);
    expect(r.excluded.expenses).toBe(1);

    const none = await owner.query(api.reports.expenseBreakdown, { from: d(2020, 1, 1), to: d(2020, 1, 31) });
    expect(none).toMatchObject({ totalCents: 0, categories: [] });
  });

  test("other scopes' categories never appear", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const theirs = await category(t, "Theirs", "org_B");
    await expense(t, theirs, 5_000, d(2026, 1, 1), { scopeId: "org_B" });
    expect((await owner.query(api.reports.expenseBreakdown, Q1)).categories).toEqual([]);
  });
});

// --- Cash flow --------------------------------------------------------------------

describe("cashFlow", () => {
  test("money in, money out, net and a running total per period", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const inv = await invoice(t, { issueDate: d(2026, 1, 1), totalCents: 50_000 });
    const cat = await category(t, "Rent");
    await payment(t, inv, 10_000, d(2026, 1, 15));
    await payment(t, inv, 5_000, d(2026, 3, 15));
    await expense(t, cat, 3_000, d(2026, 1, 20));
    await expense(t, cat, 9_000, d(2026, 2, 20));

    const r = await owner.query(api.reports.cashFlow, Q1);
    expect(r.series.map((s) => [s.period, s.inCents, s.outCents, s.netCents, s.cumulativeCents])).toEqual([
      ["2026-01", 10_000, 3_000, 7_000, 7_000],
      ["2026-02", 0, 9_000, -9_000, -2_000],
      ["2026-03", 5_000, 0, 5_000, 3_000],
    ]);
    expect(r.totals).toEqual({ inCents: 15_000, outCents: 12_000, netCents: 3_000 });
  });

  test("converts payments on foreign invoices and leaves out foreign expenses", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "business");
    const eur = await invoice(t, { currency: "EUR", exchangeRate: 1.2, totalCents: 10_000 });
    const cat = await category(t, "Travel");
    await payment(t, eur, 1_000, d(2026, 1, 15));
    await expense(t, cat, 400, d(2026, 1, 16));
    await expense(t, cat, 5_000, d(2026, 1, 17), { currency: "EUR" });

    const r = await owner.query(api.reports.cashFlow, Q1);
    expect(r.totals).toEqual({ inCents: 1_200, outCents: 400, netCents: 800 });
    expect(r.excluded).toEqual({ payments: 0, expenses: 1 });
  });

  test("zero-fills an empty range and never mixes scopes", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const theirs = await invoice(t, { scopeId: "org_B" });
    await payment(t, theirs, 9_999, d(2026, 1, 15), "org_B");
    const r = await owner.query(api.reports.cashFlow, Q1);
    expect(r.series).toHaveLength(3);
    expect(r.totals).toEqual({ inCents: 0, outCents: 0, netCents: 0 });
  });
});
