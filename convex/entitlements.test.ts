/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import {
  PLAN_LIMITS,
  entitlementsFor,
  resolvePlanKey,
} from "./lib/entitlements";
import { monthOf } from "./lib/period";
import type { PlanKey, Scope } from "./lib/validators";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const q = (name: string) => makeFunctionReference<"query">(`tenancy.testfns:${name}`);
const m = (name: string) => makeFunctionReference<"mutation">(`tenancy.testfns:${name}`);

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
    admin: t.withIdentity(identity("user_adm", { id: "org_A", rol: "admin" })),
    accountant: t.withIdentity(identity("user_acc", { id: "org_A", rol: "accountant" })),
    viewer: t.withIdentity(identity("user_view", { id: "org_A", rol: "member" })),
    bob: t.withIdentity(identity("user_bob", { id: "org_B", rol: "owner" })),
    personal: t.withIdentity(identity("user_alice")),
  };
}
type Ctx = ReturnType<typeof setup>;

let itemSeq = 0;
/** Stands in for the webhook sync: writes a subscription row for a payer. */
function subscribe(
  t: Ctx["t"],
  scopeId: string,
  planKey: PlanKey,
  status = "active",
  scopeKind: "org" | "user" = "org",
) {
  return t.run((ctx) =>
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
}

type Actor = Ctx["owner"];
const makeClients = async (actor: Actor, n: number) => {
  const ids = [];
  for (let i = 0; i < n; i++) {
    ids.push(await actor.mutation(m("createClient"), { name: `Client ${i + 1}` }));
  }
  return ids;
};
const invoiceArgs = (clientId: unknown) => ({
  clientId,
  status: "draft" as const,
  totalCents: 1000,
});

// --- Pure logic --------------------------------------------------------------

describe("resolvePlanKey", () => {
  const row = (planKey: PlanKey, status: string) => ({ planKey, status });

  test("no subscription resolves to Free, never open", () => {
    expect(resolvePlanKey([])).toBe("free");
  });

  test("an active paid plan applies", () => {
    expect(resolvePlanKey([row("pro", "active")])).toBe("pro");
  });

  test("a cancelled plan still applies until Clerk says it has ended", () => {
    expect(resolvePlanKey([row("business", "canceled")])).toBe("business");
  });

  test.each(["past_due", "ended", "expired", "upcoming", "incomplete", "abandoned", "weird"])(
    "%s does not entitle the payer",
    (status) => {
      expect(resolvePlanKey([row("business", status)])).toBe("free");
    },
  );

  test("the best entitled item wins; an ended one is ignored", () => {
    expect(resolvePlanKey([row("business", "ended"), row("pro", "active")])).toBe("pro");
    expect(resolvePlanKey([row("pro", "active"), row("business", "active")])).toBe(
      "business",
    );
  });
});

describe("entitlementsFor / PLAN_LIMITS", () => {
  test("Free is 5 clients, 10 invoices a month, 1 seat, core features only", () => {
    const free = entitlementsFor("free", "org");
    expect(free).toMatchObject({ clients: 5, invoicesPerMonth: 10, seats: 1 });
    expect(free.features).toContain("invoices");
    expect(free.features).not.toContain("reports");
  });

  test("Pro lifts the quotas and adds reports and recurring invoices", () => {
    const pro = entitlementsFor("pro", "org");
    expect(pro.clients).toBe(Infinity);
    expect(pro.invoicesPerMonth).toBe(Infinity);
    expect(pro.seats).toBe(5);
    expect(pro.features).toEqual(expect.arrayContaining(["reports", "recurring_invoices"]));
    expect(pro.features).not.toContain("receipt_scanning");
  });

  test("Business has every feature and 20 seats (Clerk's cap), not unlimited", () => {
    const business = entitlementsFor("business", "org");
    expect(business.seats).toBe(20);
    expect(business.features).toEqual(
      expect.arrayContaining(["reports", "recurring_invoices", "receipt_scanning", "multi_currency"]),
    );
    expect(PLAN_LIMITS.business.orgSeats).toBe(20);
  });

  test("a personal workspace always has exactly one seat", () => {
    expect(entitlementsFor("business", "user").seats).toBe(1);
    expect(entitlementsFor("pro", "user").seats).toBe(1);
  });
});

// --- Quotas, enforced by the server ------------------------------------------
// createClient / createInvoice in tenancy.testfns.ts contain no quota code at
// all. Every refusal below therefore comes from the scoped writer, which is
// what makes the limit impossible for a future mutation to forget.

describe("quotas (crafted requests straight against Convex)", () => {
  test("a Free scope is refused its 6th client, with a typed UPGRADE_REQUIRED", async () => {
    const { t, owner } = setup();
    await makeClients(owner, 5);

    await expect(owner.mutation(m("createClient"), { name: "Sixth" })).rejects.toMatchObject({
      data: {
        code: "UPGRADE_REQUIRED",
        reason: "quota",
        metric: "clients",
        limit: 5,
        used: 5,
        currentPlan: "free",
        requiredPlan: "pro",
      },
    });
    // The refused insert left nothing behind, and the counter is unmoved.
    expect(await t.run((ctx) => ctx.db.query("clients").collect())).toHaveLength(5);
    const [counter] = await t.run((ctx) => ctx.db.query("usageCounters").collect());
    expect(counter.count).toBe(5);
  });

  test("a Free scope is refused its 11th invoice in a month", async () => {
    const { t, owner } = setup();
    const [clientId] = await makeClients(owner, 1);
    for (let i = 0; i < 10; i++) {
      await owner.mutation(m("createInvoice"), invoiceArgs(clientId));
    }
    await expect(
      owner.mutation(m("createInvoice"), invoiceArgs(clientId)),
    ).rejects.toMatchObject({
      data: { code: "UPGRADE_REQUIRED", reason: "quota", metric: "invoices", limit: 10, used: 10 },
    });
    expect(await t.run((ctx) => ctx.db.query("invoices").collect())).toHaveLength(10);
  });

  test("deleting a client frees its slot", async () => {
    const { owner } = setup();
    const ids = await makeClients(owner, 5);
    await expect(owner.mutation(m("createClient"), { name: "X" })).rejects.toThrow();
    await owner.mutation(m("deleteClient"), { id: ids[0] });
    await owner.mutation(m("createClient"), { name: "Fits now" });
  });

  test("invoices are counted per month: last month's do not count", async () => {
    const { t, owner } = setup();
    const [clientId] = await makeClients(owner, 1);
    await t.run((ctx) =>
      ctx.db.insert("usageCounters", {
        scopeId: "org_A",
        scopeKind: "org",
        metric: "invoices",
        period: monthOf(Date.now() - 45 * 24 * 60 * 60 * 1000),
        count: 10,
      }),
    );
    await owner.mutation(m("createInvoice"), invoiceArgs(clientId));
  });

  test("a paid plan lifts both quotas", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const ids = await makeClients(owner, 6);
    for (let i = 0; i < 11; i++) {
      await owner.mutation(m("createInvoice"), invoiceArgs(ids[0]));
    }
  });

  test.each([
    ["active", true],
    ["canceled", true],
    ["past_due", false],
    ["ended", false],
  ])("a Pro subscription in status %s lifts the client cap: %s", async (status, lifted) => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro", status);
    await makeClients(owner, 5);
    const sixth = owner.mutation(m("createClient"), { name: "Sixth" });
    if (lifted) await sixth;
    else await expect(sixth).rejects.toMatchObject({ data: { code: "UPGRADE_REQUIRED" } });
  });

  test("a plan is per scope: another org's subscription does not help", async () => {
    const { t, owner, bob } = setup();
    await subscribe(t, "org_B", "business");
    await makeClients(owner, 5);
    await expect(owner.mutation(m("createClient"), { name: "X" })).rejects.toThrow();
    // ...and org A being at its cap does not touch org B.
    await makeClients(bob, 8);
  });

  test("personal scope has the Free limits too, and upgrades on its own", async () => {
    const { t, personal } = setup();
    await makeClients(personal, 5);
    await expect(personal.mutation(m("createClient"), { name: "X" })).rejects.toMatchObject({
      data: { code: "UPGRADE_REQUIRED", currentPlan: "free" },
    });
    await subscribe(t, "user_alice", "pro", "active", "user");
    await personal.mutation(m("createClient"), { name: "Now fits" });
  });

  test("the explicit-scope internal builder (cron, seeding) is held to the same limit", async () => {
    const { t } = setup();
    const scope: Scope = {
      scopeId: "org_A",
      scopeKind: "org",
      userId: "system",
      role: "owner",
    };
    for (let i = 0; i < 5; i++) {
      await t.mutation(m("seedClient"), { scope, name: `C${i}` });
    }
    await expect(t.mutation(m("seedClient"), { scope, name: "C5" })).rejects.toMatchObject({
      data: { code: "UPGRADE_REQUIRED" },
    });
  });

  test("a foreign-scope insert still fails as not-allowed, not as a quota error", async () => {
    const { owner } = setup();
    await makeClients(owner, 5);
    await expect(owner.mutation(m("forgeClient"), { scopeId: "org_B" })).rejects.toThrow(
      /insert access not allowed/,
    );
  });
});

// --- Feature gates -------------------------------------------------------------

describe("feature gates", () => {
  test("a premium feature is refused on Free, naming the plan that unlocks it", async () => {
    const { owner } = setup();
    await expect(owner.query(q("gate"), { feature: "reports" })).rejects.toMatchObject({
      data: {
        code: "UPGRADE_REQUIRED",
        reason: "feature",
        feature: "reports",
        currentPlan: "free",
        requiredPlan: "pro",
      },
    });
    await expect(
      owner.query(q("gate"), { feature: "receipt_scanning" }),
    ).rejects.toMatchObject({ data: { feature: "receipt_scanning", requiredPlan: "business" } });
  });

  test("Pro has reports but not receipt scanning; Business has everything", async () => {
    const { t, owner, bob } = setup();
    await subscribe(t, "org_A", "pro");
    await subscribe(t, "org_B", "business");

    expect(await owner.query(q("gate"), { feature: "reports" })).toBe("pro");
    await expect(
      owner.query(q("gate"), { feature: "receipt_scanning" }),
    ).rejects.toMatchObject({ data: { currentPlan: "pro", requiredPlan: "business" } });
    await expect(owner.query(q("gate"), { feature: "multi_currency" })).rejects.toThrow();

    for (const feature of ["reports", "recurring_invoices", "receipt_scanning", "multi_currency"] as const) {
      expect(await bob.query(q("gate"), { feature })).toBe("business");
    }
  });

  test("core features are on every plan, Free included", async () => {
    const { owner } = setup();
    for (const feature of ["invoices", "expenses", "clients", "settings", "audit"] as const) {
      expect(await owner.query(q("gate"), { feature })).toBe("free");
    }
  });

  test("recurring templates cannot be created on Free, by any write path", async () => {
    const { t, owner } = setup();
    const [clientId] = await makeClients(owner, 1);

    await expect(owner.mutation(m("createRecurring"), { clientId })).rejects.toMatchObject({
      data: { code: "UPGRADE_REQUIRED", feature: "recurring_invoices", requiredPlan: "pro" },
    });
    expect(await t.run((ctx) => ctx.db.query("recurringInvoices").collect())).toHaveLength(0);

    await subscribe(t, "org_A", "pro");
    await owner.mutation(m("createRecurring"), { clientId });
    expect(await t.run((ctx) => ctx.db.query("recurringInvoices").collect())).toHaveLength(1);
  });
});

// --- getUsageSummary -------------------------------------------------------------

describe("getUsageSummary", () => {
  test("reports plan, features, usage and limits for a Free org", async () => {
    const { t, owner } = setup();
    const [clientId] = await makeClients(owner, 2);
    await owner.mutation(m("createInvoice"), invoiceArgs(clientId));
    await t.run(async (ctx) => {
      for (const user of ["user_alice", "user_adm"]) {
        await ctx.db.insert("memberships", {
          scopeId: "org_A",
          clerkUserId: user,
          role: "org:owner",
          joinedAt: 0,
        });
      }
    });

    const summary = await owner.query(api.usage.getUsageSummary, { now: Date.now() });
    expect(summary).toMatchObject({
      plan: "free",
      clients: { used: 2, limit: 5 },
      invoices: { used: 1, limit: 10 },
      seats: { used: 2, limit: 1 },
    });
    expect(summary.features).toContain("invoices");
    expect(summary.features).not.toContain("reports");
  });

  test("unlimited is null, and a paid plan reports its seat cap", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const summary = await owner.query(api.usage.getUsageSummary, { now: Date.now() });
    expect(summary).toMatchObject({
      plan: "pro",
      clients: { limit: null },
      invoices: { limit: null },
      seats: { limit: 5 },
    });
  });

  test("a personal workspace has one seat, used", async () => {
    const { personal } = setup();
    const summary = await personal.query(api.usage.getUsageSummary, { now: Date.now() });
    expect(summary.seats).toEqual({ used: 1, limit: 1 });
  });

  test("the month it is asked about selects the invoice counter", async () => {
    const { owner } = setup();
    const [clientId] = await makeClients(owner, 1);
    await owner.mutation(m("createInvoice"), invoiceArgs(clientId));
    const nextYear = Date.now() + 366 * 24 * 60 * 60 * 1000;
    const summary = await owner.query(api.usage.getUsageSummary, { now: nextYear });
    expect(summary.invoices.used).toBe(0);
  });

  test("each scope sees only its own usage", async () => {
    const { owner, bob } = setup();
    await makeClients(owner, 3);
    const seen = await bob.query(api.usage.getUsageSummary, { now: Date.now() });
    expect(seen.clients.used).toBe(0);
  });

  test("it needs a signed-in caller", async () => {
    const { t } = setup();
    await expect(t.query(api.usage.getUsageSummary, { now: Date.now() })).rejects.toMatchObject({
      data: { code: "UNAUTHENTICATED" },
    });
  });
});

// --- listAuditLog -------------------------------------------------------------

describe("listAuditLog", () => {
  const page = (numItems: number, cursor: string | null = null) => ({
    numItems,
    cursor,
  });

  test("is refused to roles without audit.read", async () => {
    const { viewer, accountant } = setup();
    for (const actor of [viewer, accountant]) {
      await expect(
        actor.query(api.audit.listAuditLog, { paginationOpts: page(10) }),
      ).rejects.toMatchObject({ data: { code: "FORBIDDEN", capability: "audit.read" } });
    }
  });

  test("is allowed to admins, owners and a personal workspace", async () => {
    const { admin, owner, personal } = setup();
    await owner.mutation(m("createClient"), { name: "A" });
    await personal.mutation(m("createClient"), { name: "P" });
    for (const actor of [admin, owner, personal]) {
      const result = await actor.query(api.audit.listAuditLog, { paginationOpts: page(10) });
      expect(result.page).toHaveLength(1);
    }
  });

  test("lists newest first and pages through", async () => {
    const { owner } = setup();
    const id = await owner.mutation(m("createClient"), { name: "Acme" });
    await owner.mutation(m("renameClient"), { id, name: "Acme Ltd" });
    await owner.mutation(m("deleteClient"), { id });

    const first = await owner.query(api.audit.listAuditLog, { paginationOpts: page(2) });
    expect(first.page.map((r) => r.action)).toEqual(["delete", "update"]);
    expect(first.isDone).toBe(false);

    const second = await owner.query(api.audit.listAuditLog, {
      paginationOpts: page(2, first.continueCursor),
    });
    expect(second.page.map((r) => r.action)).toEqual(["create"]);
    expect(second.isDone).toBe(true);
  });

  test("can be narrowed to one record's history", async () => {
    const { owner } = setup();
    const a = await owner.mutation(m("createClient"), { name: "A" });
    const b = await owner.mutation(m("createClient"), { name: "B" });
    await owner.mutation(m("renameClient"), { id: a, name: "A2" });

    const history = await owner.query(api.audit.listAuditLog, {
      paginationOpts: page(10),
      entity: { table: "clients", id: a },
    });
    expect(history.page.map((r) => r.action).sort()).toEqual(["create", "update"]);
    expect(history.page.every((r) => r.entityId === a)).toBe(true);
    expect(history.page.some((r) => r.entityId === b)).toBe(false);
  });

  test("never shows another scope's trail, even when asked for its record", async () => {
    const { owner, bob } = setup();
    const bobsClient = await bob.mutation(m("createClient"), { name: "Bob Co" });
    await owner.mutation(m("createClient"), { name: "Mine" });

    const mine = await owner.query(api.audit.listAuditLog, { paginationOpts: page(10) });
    expect(mine.page).toHaveLength(1);
    expect(mine.page[0].entityLabel).toBe("Mine");

    const probe = await owner.query(api.audit.listAuditLog, {
      paginationOpts: page(10),
      entity: { table: "clients", id: bobsClient },
    });
    expect(probe.page).toEqual([]);
  });
});
