/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { PlanKey } from "./lib/validators";
import { setup, subscribe } from "./testkit.testutil";
import type { Ctx } from "./testkit.testutil";

const ORG = "org_A";
const scope = { scopeId: ORG, scopeKind: "org" as const, userId: "user_alice", role: "owner" as const };

async function orgOn(plan: PlanKey) {
  const { t } = setup();
  await t.mutation(internal.sync.upsertOrganization, { clerkOrgId: ORG, name: "Acme Inc." });
  if (plan !== "free") await subscribe(t, ORG, plan);
  return t;
}

const rows = (t: Ctx["t"]) =>
  t.run(async (ctx) => ({
    clients: await ctx.db.query("clients").collect(),
    invoices: await ctx.db.query("invoices").collect(),
    recurring: await ctx.db.query("recurringInvoices").collect(),
    expenses: await ctx.db.query("expenses").collect(),
    counters: await ctx.db.query("usageCounters").collect(),
  }));

describe("seedScope is shaped by the plan", () => {
  test("Free: at the caps, base currency only, no recurring", async () => {
    const t = await orgOn("free");
    const result = await t.mutation(internal.seed.seedScope, { scope });
    expect(result).toMatchObject({ plan: "free", clients: 5, invoices: 10, recurring: 0, currencies: ["USD"] });

    const r = await rows(t);
    expect(r.clients).toHaveLength(5);
    expect(r.invoices).toHaveLength(10);
    expect(r.recurring).toHaveLength(0);
    expect(r.clients.every((c) => c.currency === "USD")).toBe(true);
  });

  test("Free: oversized overrides and foreign currencies are clamped away", async () => {
    const t = await orgOn("free");
    const result = await t.mutation(internal.seed.seedScope, {
      scope,
      clientCount: 24,
      invoiceCount: 180,
      recurringCount: 3,
      extraCurrencies: [{ code: "EUR", rate: 1.08 }],
    });
    expect(result).toMatchObject({ clients: 5, invoices: 10, recurring: 0, currencies: ["USD"] });
  });

  test("Free: reseeding an at-cap scope adds nothing it can't hold", async () => {
    const t = await orgOn("free");
    await t.mutation(internal.seed.seedScope, { scope });
    const again = await t.mutation(internal.seed.seedScope, { scope });
    expect(again).toMatchObject({ clients: 0, invoices: 0 });
    expect((await rows(t)).clients).toHaveLength(5);
  });

  test("Pro: history and recurring templates, still base currency only", async () => {
    const t = await orgOn("pro");
    const result = await t.mutation(internal.seed.seedScope, {
      scope,
      clientCount: 6,
      invoiceCount: 20,
      expenseCount: 5,
      extraCurrencies: [{ code: "EUR", rate: 1.08 }],
    });
    expect(result).toMatchObject({ plan: "pro", clients: 6, invoices: 20, recurring: 3, currencies: ["USD"] });
    const r = await rows(t);
    expect(r.recurring).toHaveLength(3);
    expect(r.clients.every((c) => c.currency === "USD")).toBe(true);
  });

  test("Business: foreign currencies are available", async () => {
    const t = await orgOn("business");
    const result = await t.mutation(internal.seed.seedScope, {
      scope,
      clientCount: 24,
      invoiceCount: 20,
      expenseCount: 5,
    });
    expect(result.plan).toBe("business");
    expect(result.currencies).toEqual(["USD", "EUR", "GBP", "CAD"]);
    const r = await rows(t);
    // Every foreign-currency invoice carries the rate that converts it back.
    for (const inv of r.invoices) {
      expect(inv.currency === "USD" || inv.exchangeRate !== undefined).toBe(true);
    }
  });

  test("expectPlan refuses a scope whose subscription hasn't synced", async () => {
    const t = await orgOn("free");
    await expect(
      t.mutation(internal.seed.seedScope, { scope, expectPlan: "pro" }),
    ).rejects.toThrow(/resolves to the "free" plan/);
    expect((await rows(t)).clients).toHaveLength(0);
  });
});

describe("clearScope", () => {
  test("empties the scope's books and leaves other scopes alone", async () => {
    const t = await orgOn("pro");
    await t.mutation(internal.sync.upsertOrganization, { clerkOrgId: "org_B", name: "Other" });
    await t.mutation(internal.seed.seedScope, { scope, clientCount: 4, invoiceCount: 8, expenseCount: 3 });
    await t.mutation(internal.seed.seedScope, {
      scope: { ...scope, scopeId: "org_B" },
      clientCount: 2,
      invoiceCount: 2,
      expenseCount: 1,
    });

    expect(await t.mutation(internal.seed.clearScope, { scopeId: ORG })).toMatchObject({
      continuing: false,
    });

    const r = await rows(t);
    for (const list of [r.clients, r.invoices, r.recurring, r.expenses, r.counters]) {
      expect(list.every((row) => row.scopeId === "org_B")).toBe(true);
    }
    expect(r.clients).toHaveLength(2);
    // Reseeding after a clear starts from empty quotas again.
    await t.mutation(internal.seed.seedScope, { scope, expectPlan: "pro", clientCount: 3, invoiceCount: 3, expenseCount: 1 });
    expect((await rows(t)).clients.filter((c) => c.scopeId === ORG)).toHaveLength(3);
  });
});
