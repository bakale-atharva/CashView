/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import type { Scope } from "./lib/validators";

const modules = import.meta.glob("./**/*.ts");

const ref = <T extends "query" | "mutation">(name: string) =>
  makeFunctionReference<T>(`tenancy.testfns:${name}`);
const q = (name: string) => ref<"query">(name);
const m = (name: string) => ref<"mutation">(name);

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
    // Org A
    aliceOwner: t.withIdentity(identity("user_alice", { id: "org_A", rol: "owner" })),
    aliceAccountant: t.withIdentity(
      identity("user_acc", { id: "org_A", rol: "accountant" }),
    ),
    aliceAdmin: t.withIdentity(identity("user_adm", { id: "org_A", rol: "admin" })),
    aliceViewer: t.withIdentity(identity("user_view", { id: "org_A", rol: "member" })),
    // Org B
    bob: t.withIdentity(identity("user_bob", { id: "org_B", rol: "admin" })),
    // Alice's personal scope (same person as aliceOwner, no org active)
    alicePersonal: t.withIdentity(identity("user_alice")),
    anonymous: t,
  };
}

const orgScope = (id: string): Scope => ({
  scopeId: id,
  scopeKind: "org",
  userId: "system",
  role: "admin",
});

describe("authentication", () => {
  test("no identity is refused with UNAUTHENTICATED", async () => {
    const { anonymous } = setup();
    await expect(anonymous.query(q("whoami"), {})).rejects.toMatchObject({
      data: { code: "UNAUTHENTICATED" },
    });
    await expect(
      anonymous.mutation(m("createClient"), { name: "X" }),
    ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
  });

  test("a malformed org claim fails closed", async () => {
    const { t } = setup();
    const bad = t.withIdentity({
      issuer: ISSUER,
      subject: "user_x",
      tokenIdentifier: `${ISSUER}|user_x`,
      o: { rol: "admin" },
    });
    await expect(bad.query(q("whoami"), {})).rejects.toMatchObject({
      data: { code: "UNAUTHENTICATED" },
    });
  });

  test("scope is derived from the token: org vs personal", async () => {
    const { aliceOwner, alicePersonal } = setup();
    expect(await aliceOwner.query(q("whoami"), {})).toMatchObject({
      scopeId: "org_A",
      scopeKind: "org",
      role: "owner",
    });
    expect(await alicePersonal.query(q("whoami"), {})).toMatchObject({
      scopeId: "user_alice",
      scopeKind: "user",
    });
  });
});

describe("cross-tenant isolation", () => {
  test("org A cannot read org B's row by id", async () => {
    const { aliceOwner, bob } = setup();
    const bobsClient = await bob.mutation(m("createClient"), { name: "Bob Co" });

    expect(await aliceOwner.query(q("getClient"), { id: bobsClient })).toBeNull();
    await expect(
      aliceOwner.query(q("getClientOrThrow"), { id: bobsClient }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    // The owner still sees it.
    expect(await bob.query(q("getClient"), { id: bobsClient })).toMatchObject({
      name: "Bob Co",
    });
  });

  test("a foreign row and a missing row are indistinguishable", async () => {
    const { t, aliceOwner, bob } = setup();
    const bobsClient = await bob.mutation(m("createClient"), { name: "Bob Co" });
    const deletedId = await aliceOwner.mutation(m("createClient"), { name: "Gone" });
    await aliceOwner.mutation(m("deleteClient"), { id: deletedId });

    const foreign = await aliceOwner
      .query(q("getClientOrThrow"), { id: bobsClient })
      .catch((e) => e.data);
    const missing = await aliceOwner
      .query(q("getClientOrThrow"), { id: deletedId })
      .catch((e) => e.data);
    expect(foreign).toEqual(missing);
    void t;
  });

  test("personal scope cannot see org rows, nor org see personal rows", async () => {
    const { aliceOwner, alicePersonal } = setup();
    const orgClient = await aliceOwner.mutation(m("createClient"), { name: "Org" });
    const personalClient = await alicePersonal.mutation(m("createClient"), {
      name: "Mine",
    });

    // Same human, different active scope.
    expect(await alicePersonal.query(q("getClient"), { id: orgClient })).toBeNull();
    expect(await aliceOwner.query(q("getClient"), { id: personalClient })).toBeNull();
    expect(await alicePersonal.query(q("listClientsUnfiltered"), {})).toHaveLength(1);
    expect(await aliceOwner.query(q("listClientsUnfiltered"), {})).toHaveLength(1);
  });

  test("row-level security holds for a query that forgets its scopeId filter", async () => {
    const { aliceOwner, bob } = setup();
    await aliceOwner.mutation(m("createClient"), { name: "A1" });
    await aliceOwner.mutation(m("createClient"), { name: "A2" });
    await bob.mutation(m("createClient"), { name: "B1" });

    const seenByA = await aliceOwner.query(q("listClientsUnfiltered"), {});
    expect(seenByA.map((c: { name: string }) => c.name).sort()).toEqual(["A1", "A2"]);
    const seenByB = await bob.query(q("listClientsUnfiltered"), {});
    expect(seenByB.map((c: { name: string }) => c.name)).toEqual(["B1"]);
  });

  test("cannot patch or delete another tenant's row", async () => {
    const { aliceOwner, bob, t } = setup();
    const bobsClient = await bob.mutation(m("createClient"), { name: "Bob Co" });

    await expect(
      aliceOwner.mutation(m("renameClient"), { id: bobsClient, name: "Pwned" }),
    ).rejects.toThrow();
    await expect(
      aliceOwner.mutation(m("deleteClient"), { id: bobsClient }),
    ).rejects.toThrow();

    const row = await t.run((ctx) => ctx.db.get("clients", bobsClient));
    expect(row?.name).toBe("Bob Co");
  });

  test("cannot insert a row into another tenant's scope", async () => {
    const { aliceOwner, t } = setup();
    await expect(
      aliceOwner.mutation(m("forgeClient"), { scopeId: "org_B" }),
    ).rejects.toThrow(/insert access not allowed/);
    expect(await t.run((ctx) => ctx.db.query("clients").collect())).toHaveLength(0);
  });

  test("cannot move an owned row into another tenant by patching scopeId", async () => {
    const { aliceOwner, t } = setup();
    const id = await aliceOwner.mutation(m("createClient"), { name: "Mine" });
    await expect(
      aliceOwner.mutation(m("moveClient"), { id, scopeId: "org_B" }),
    ).rejects.toMatchObject({ data: { code: "SCOPE_IMMUTABLE" } });
    // The failed mutation rolled back completely.
    expect((await t.run((ctx) => ctx.db.get("clients", id)))?.scopeId).toBe("org_A");
  });

  test("global tables are invisible to scoped functions", async () => {
    const { aliceOwner, t } = setup();
    await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkUserId: "user_other",
        tokenIdentifier: `${ISSUER}|user_other`,
        email: "other@example.com",
      }),
    );
    expect(await aliceOwner.query(q("listUsers"), {})).toEqual([]);
  });

  test("read-only tables cannot be written by scoped functions", async () => {
    const { aliceOwner } = setup();
    await expect(
      aliceOwner.mutation(m("writeAuditDirectly"), {}),
    ).rejects.toThrow(/insert access not allowed/);
    await expect(
      aliceOwner.mutation(m("writeSubscriptionDirectly"), {}),
    ).rejects.toThrow(/insert access not allowed/);
  });

  test("the explicit-scope internal builder is bound to the scope it is given", async () => {
    const { aliceOwner, t } = setup();
    const id = await t.mutation(m("seedClient"), {
      scope: orgScope("org_B"),
      name: "Seeded",
    });
    expect(await aliceOwner.query(q("getClient"), { id })).toBeNull();
    expect((await t.run((ctx) => ctx.db.get("clients", id)))?.scopeId).toBe("org_B");
  });
});

describe("roles", () => {
  test("a viewer (including Clerk's built-in member) cannot write", async () => {
    const { aliceViewer } = setup();
    await expect(
      aliceViewer.mutation(m("createClient"), { name: "X" }),
    ).rejects.toMatchObject({
      data: { code: "FORBIDDEN", capability: "clients.write" },
    });
  });

  test("an accountant and an owner can write", async () => {
    const { aliceAccountant, aliceOwner } = setup();
    await aliceAccountant.mutation(m("createClient"), { name: "By accountant" });
    await aliceOwner.mutation(m("createClient"), { name: "By owner" });
    expect(await aliceOwner.query(q("listClientsUnfiltered"), {})).toHaveLength(2);
  });

  test("personal scope may write", async () => {
    const { alicePersonal } = setup();
    await alicePersonal.mutation(m("createClient"), { name: "Solo" });
  });

  test("org-only mutations refuse personal scope", async () => {
    const { alicePersonal, aliceOwner } = setup();
    await expect(alicePersonal.mutation(m("orgPing"), {})).rejects.toMatchObject({
      data: { code: "ORG_REQUIRED" },
    });
    expect(await aliceOwner.mutation(m("orgPing"), {})).toBe("org_A");
  });
});

describe("triggers run without the mutation asking", () => {
  test("creating a client writes an audit row and moves the counter", async () => {
    const { t, aliceOwner } = setup();
    await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkUserId: "user_alice",
        tokenIdentifier: `${ISSUER}|user_alice`,
        email: "alice@example.com",
      }),
    );

    // createClient contains no audit or counter code.
    const id = await aliceOwner.mutation(m("createClient"), { name: "Acme" });

    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      scopeId: "org_A",
      scopeKind: "org",
      actorUserId: "user_alice",
      actorEmail: "alice@example.com",
      actorRole: "owner",
      action: "create",
      entityTable: "clients",
      entityId: id,
      entityLabel: "Acme",
      summary: 'Created client "Acme"',
    });

    const usage = await t.run((ctx) => ctx.db.query("usageCounters").collect());
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      scopeId: "org_A",
      metric: "clients",
      period: "all",
      count: 1,
    });
  });

  test("the audit row is written even when the actor has no synced user yet", async () => {
    const { t, aliceOwner } = setup();
    await aliceOwner.mutation(m("createClient"), { name: "Acme" });
    const [row] = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(row.actorEmail).toBeUndefined();
    expect(row.actorUserId).toBe("user_alice");
  });

  test("an update records a field-level diff", async () => {
    const { t, aliceOwner } = setup();
    const id = await aliceOwner.mutation(m("createClient"), { name: "Acme" });
    await aliceOwner.mutation(m("renameClient"), { id, name: "Acme Ltd" });

    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    const update = audit.find((a) => a.action === "update");
    expect(update?.changes).toEqual([{ field: "name", from: "Acme", to: "Acme Ltd" }]);
    expect(update?.summary).toBe('Updated client "Acme Ltd" (name)');
  });

  test("changes to denormalized bookkeeping fields are not audited", async () => {
    const { t, aliceOwner } = setup();
    const id = await aliceOwner.mutation(m("createClient"), { name: "Acme" });
    await aliceOwner.mutation(m("bumpClientBalance"), { id, outstandingCents: 500 });
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audit.filter((a) => a.action === "update")).toHaveLength(0);
  });

  test("audit rows are scoped like everything else", async () => {
    const { aliceOwner, bob } = setup();
    await aliceOwner.mutation(m("createClient"), { name: "A" });
    await bob.mutation(m("createClient"), { name: "B" });
    const seen = await aliceOwner.query(q("listAudit"), {});
    expect(seen).toHaveLength(1);
    expect(seen[0].entityLabel).toBe("A");
  });

  test("deleting a client audits it and decrements the counter", async () => {
    const { t, aliceOwner } = setup();
    const id = await aliceOwner.mutation(m("createClient"), { name: "Acme" });
    await aliceOwner.mutation(m("deleteClient"), { id });

    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audit.map((a) => a.action)).toEqual(["create", "delete"]);
    const [counter] = await t.run((ctx) => ctx.db.query("usageCounters").collect());
    expect(counter.count).toBe(0);
  });

  test("counters are per scope", async () => {
    const { aliceOwner, bob } = setup();
    await aliceOwner.mutation(m("createClient"), { name: "A1" });
    await aliceOwner.mutation(m("createClient"), { name: "A2" });
    await bob.mutation(m("createClient"), { name: "B1" });

    expect((await aliceOwner.query(q("listUsage"), {}))[0].count).toBe(2);
    expect((await bob.query(q("listUsage"), {}))[0].count).toBe(1);
  });

  test("the invoice counter is bucketed by creation month", async () => {
    const { t, aliceOwner } = setup();
    const clientId = await aliceOwner.mutation(m("createClient"), { name: "Acme" });
    const invoiceId = await aliceOwner.mutation(m("createInvoice"), {
      clientId,
      status: "draft",
      totalCents: 1000,
    });

    const month = new Date().toISOString().slice(0, 7);
    const counters = await t.run((ctx) => ctx.db.query("usageCounters").collect());
    expect(
      counters.find((c) => c.metric === "invoices" && c.period === month)?.count,
    ).toBe(1);

    await aliceOwner.mutation(m("deleteInvoice"), { id: invoiceId });
    const after = await t.run((ctx) => ctx.db.query("usageCounters").collect());
    expect(
      after.find((c) => c.metric === "invoices" && c.period === month)?.count,
    ).toBe(0);
  });
});

describe("client balances follow invoices and payments", () => {
  const balances = (t: ReturnType<typeof setup>["t"], id: string) =>
    t.run(async (ctx) => {
      const c = await ctx.db.get("clients", id as never);
      return {
        billed: c?.totalBilledCents,
        paid: c?.totalPaidCents,
        outstanding: c?.outstandingCents,
      };
    });

  test("a draft invoice contributes nothing; sending it bills the client", async () => {
    const { t, aliceOwner } = setup();
    const clientId = await aliceOwner.mutation(m("createClient"), { name: "Acme" });
    const invoiceId = await aliceOwner.mutation(m("createInvoice"), {
      clientId,
      status: "draft",
      totalCents: 10_000,
    });
    expect(await balances(t, clientId)).toEqual({ billed: 0, paid: 0, outstanding: 0 });

    await aliceOwner.mutation(m("setInvoiceStatus"), { id: invoiceId, status: "sent" });
    expect(await balances(t, clientId)).toEqual({
      billed: 10_000,
      paid: 0,
      outstanding: 10_000,
    });
  });

  test("payments derive the invoice's paidCents and flow to the client", async () => {
    const { t, aliceOwner } = setup();
    const clientId = await aliceOwner.mutation(m("createClient"), { name: "Acme" });
    const invoiceId = await aliceOwner.mutation(m("createInvoice"), {
      clientId,
      status: "sent",
      totalCents: 10_000,
    });

    const p1 = await aliceOwner.mutation(m("recordPayment"), {
      invoiceId,
      clientId,
      amountCents: 4_000,
    });
    await aliceOwner.mutation(m("recordPayment"), {
      invoiceId,
      clientId,
      amountCents: 1_500,
    });

    expect((await t.run((ctx) => ctx.db.get("invoices", invoiceId)))?.paidCents).toBe(
      5_500,
    );
    expect(await balances(t, clientId)).toEqual({
      billed: 10_000,
      paid: 5_500,
      outstanding: 4_500,
    });

    await aliceOwner.mutation(m("deletePayment"), { id: p1 });
    expect((await t.run((ctx) => ctx.db.get("invoices", invoiceId)))?.paidCents).toBe(
      1_500,
    );
    expect(await balances(t, clientId)).toEqual({
      billed: 10_000,
      paid: 1_500,
      outstanding: 8_500,
    });
  });

  test("voiding or deleting an invoice takes it out of the balances", async () => {
    const { t, aliceOwner } = setup();
    const clientId = await aliceOwner.mutation(m("createClient"), { name: "Acme" });
    const a = await aliceOwner.mutation(m("createInvoice"), {
      clientId,
      status: "sent",
      totalCents: 3_000,
    });
    const b = await aliceOwner.mutation(m("createInvoice"), {
      clientId,
      status: "overdue",
      totalCents: 2_000,
    });
    expect((await balances(t, clientId)).outstanding).toBe(5_000);

    await aliceOwner.mutation(m("setInvoiceStatus"), { id: a, status: "void" });
    expect((await balances(t, clientId)).outstanding).toBe(2_000);

    await aliceOwner.mutation(m("deleteInvoice"), { id: b });
    expect(await balances(t, clientId)).toEqual({ billed: 0, paid: 0, outstanding: 0 });
  });

  test("the payment's effect on the invoice is itself audited", async () => {
    const { t, aliceOwner } = setup();
    const clientId = await aliceOwner.mutation(m("createClient"), { name: "Acme" });
    const invoiceId = await aliceOwner.mutation(m("createInvoice"), {
      clientId,
      status: "sent",
      totalCents: 10_000,
    });
    await aliceOwner.mutation(m("recordPayment"), {
      invoiceId,
      clientId,
      amountCents: 4_000,
    });

    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    const paidChange = audit.find(
      (a) => a.entityTable === "invoices" && a.action === "update",
    );
    expect(paidChange?.changes).toEqual([{ field: "paidCents", from: 0, to: 4_000 }]);
    expect(paidChange?.actorUserId).toBe("user_alice");
  });
});
