/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { PlanKey } from "./lib/validators";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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
    accountant: t.withIdentity(identity("user_acc", { id: "org_A", rol: "accountant" })),
    viewer: t.withIdentity(identity("user_view", { id: "org_A", rol: "member" })),
    bob: t.withIdentity(identity("user_bob", { id: "org_B", rol: "owner" })),
    personal: t.withIdentity(identity("user_alice")),
  };
}
type Ctx = ReturnType<typeof setup>;
type Actor = Ctx["owner"];

const page = (numItems: number, cursor: string | null = null) => ({ numItems, cursor });
const listAll = async (actor: Actor, extra: { archived?: boolean; search?: string } = {}) =>
  (await actor.query(api.clients.list, { paginationOpts: page(100), ...extra })).page;

let itemSeq = 0;
const subscribe = (t: Ctx["t"], scopeId: string, planKey: PlanKey) =>
  t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      scopeId,
      scopeKind: "org",
      planKey,
      clerkPlanSlug: `${planKey}_org`,
      clerkSubscriptionItemId: `subi_${++itemSeq}`,
      status: "active",
      features: [],
    }),
  );

/** A raw invoice row for a client, bypassing triggers (no balances involved). */
const rawInvoice = (t: Ctx["t"], clientId: Id<"clients">, issueDate = 0, scopeId = "org_A") =>
  t.run((ctx) =>
    ctx.db.insert("invoices", {
      scopeId,
      scopeKind: "org",
      clientId,
      invoiceNumber: `INV-${issueDate}`,
      status: "draft",
      issueDate,
      dueDate: issueDate,
      currency: "USD",
      subtotalCents: 0,
      taxCents: 0,
      discountCents: 0,
      totalCents: 0,
      paidCents: 0,
    }),
  );

describe("create", () => {
  test("stores the client with zeroed balances, unarchived, in the caller's scope", async () => {
    const { t, owner } = setup();
    const id = await owner.mutation(api.clients.create, {
      name: "  Acme Inc. ",
      email: "billing@acme.com",
      billingAddress: { line1: "1 Main St", city: "Pune", country: "IN" },
    });
    expect(await t.run((ctx) => ctx.db.get("clients", id))).toMatchObject({
      scopeId: "org_A",
      scopeKind: "org",
      name: "Acme Inc.",
      email: "billing@acme.com",
      currency: "USD",
      isArchived: false,
      outstandingCents: 0,
      totalBilledCents: 0,
      totalPaidCents: 0,
    });
  });

  test("accepts no scope, balances or archive flag from the request", async () => {
    const { owner } = setup();
    await expect(
      owner.mutation(api.clients.create, {
        name: "X",
        scopeId: "org_B",
      } as never),
    ).rejects.toThrow();
    await expect(
      owner.mutation(api.clients.create, { name: "X", outstandingCents: 999 } as never),
    ).rejects.toThrow();
  });

  test("defaults the currency to the scope's base currency", async () => {
    const { t, owner } = setup();
    await t.run((ctx) =>
      ctx.db.insert("scopeSettings", {
        scopeId: "org_A",
        scopeKind: "org",
        currency: "GBP",
        defaultTaxRatePct: 0,
        invoiceNumberPrefix: "INV-",
        nextInvoiceSeq: 1,
        paymentTermsDays: 30,
      }),
    );
    const id = await owner.mutation(api.clients.create, { name: "Acme" });
    expect((await owner.query(api.clients.get, { id })).currency).toBe("GBP");
  });

  test("rejects bad input with a typed error naming the field", async () => {
    const { owner } = setup();
    await expect(owner.mutation(api.clients.create, { name: "  " })).rejects.toMatchObject({
      data: { code: "INVALID_INPUT", field: "name" },
    });
    await expect(
      owner.mutation(api.clients.create, { name: "A", email: "nope" }),
    ).rejects.toMatchObject({ data: { code: "INVALID_INPUT", field: "email" } });
    await expect(
      owner.mutation(api.clients.create, { name: "A", currency: "dollars" }),
    ).rejects.toMatchObject({ data: { code: "INVALID_INPUT", field: "currency" } });
  });

  test("the 6th client on Free is refused with UPGRADE_REQUIRED; Pro is not", async () => {
    const { t, owner } = setup();
    for (let i = 1; i <= 5; i++) await owner.mutation(api.clients.create, { name: `C${i}` });
    await expect(owner.mutation(api.clients.create, { name: "C6" })).rejects.toMatchObject({
      data: { code: "UPGRADE_REQUIRED", reason: "quota", metric: "clients", limit: 5 },
    });
    await subscribe(t, "org_A", "pro");
    await owner.mutation(api.clients.create, { name: "C6" });
  });

  test("a client in a non-base currency needs the multi-currency feature", async () => {
    const { t, owner } = setup();
    await expect(
      owner.mutation(api.clients.create, { name: "Euro Co", currency: "eur" }),
    ).rejects.toMatchObject({
      data: {
        code: "UPGRADE_REQUIRED",
        reason: "feature",
        feature: "multi_currency",
        requiredPlan: "business",
      },
    });
    // The base currency is always fine.
    await owner.mutation(api.clients.create, { name: "Dollar Co", currency: "USD" });

    await subscribe(t, "org_A", "business");
    const id = await owner.mutation(api.clients.create, { name: "Euro Co", currency: "eur" });
    expect((await owner.query(api.clients.get, { id })).currency).toBe("EUR");
  });

  test("is audited without create calling anything", async () => {
    const { owner } = setup();
    const id = await owner.mutation(api.clients.create, { name: "Acme" });
    const log = await owner.query(api.audit.listAuditLog, { paginationOpts: page(10) });
    expect(log.page).toMatchObject([
      { action: "create", entityTable: "clients", entityId: id, entityLabel: "Acme" },
    ]);
  });
});

describe("roles", () => {
  test("a viewer can read but every write is refused", async () => {
    const { owner, viewer } = setup();
    const id = await owner.mutation(api.clients.create, { name: "Acme" });

    expect(await listAll(viewer)).toHaveLength(1);
    expect((await viewer.query(api.clients.get, { id })).name).toBe("Acme");

    const forbidden = { data: { code: "FORBIDDEN", capability: "clients.write" } };
    await expect(viewer.mutation(api.clients.create, { name: "X" })).rejects.toMatchObject(
      forbidden,
    );
    await expect(
      viewer.mutation(api.clients.update, { id, name: "X" }),
    ).rejects.toMatchObject(forbidden);
    await expect(viewer.mutation(api.clients.archive, { id })).rejects.toMatchObject(forbidden);
    await expect(viewer.mutation(api.clients.unarchive, { id })).rejects.toMatchObject(
      forbidden,
    );
    await expect(viewer.mutation(api.clients.remove, { id })).rejects.toMatchObject(forbidden);
  });

  test("an accountant can do all of it", async () => {
    const { accountant } = setup();
    const id = await accountant.mutation(api.clients.create, { name: "A" });
    await accountant.mutation(api.clients.update, { id, name: "B" });
    await accountant.mutation(api.clients.archive, { id });
    await accountant.mutation(api.clients.unarchive, { id });
    await accountant.mutation(api.clients.remove, { id });
  });

  test("personal scope can manage its own clients", async () => {
    const { personal } = setup();
    const id = await personal.mutation(api.clients.create, { name: "Solo client" });
    expect((await listAll(personal)).map((c) => c._id)).toEqual([id]);
  });
});

describe("get", () => {
  test("returns the client with its trigger-maintained balances", async () => {
    const { owner } = setup();
    const id = await owner.mutation(api.clients.create, { name: "Acme" });
    await owner.mutation(m("createInvoice"), { clientId: id, status: "sent", totalCents: 5000 });
    await owner.mutation(m("createInvoice"), { clientId: id, status: "draft", totalCents: 900 });

    expect(await owner.query(api.clients.get, { id })).toMatchObject({
      totalBilledCents: 5000,
      totalPaidCents: 0,
      outstandingCents: 5000,
    });
  });

  test("another org's client, and a missing one, both read as NOT_FOUND", async () => {
    const { owner, bob } = setup();
    const bobs = await bob.mutation(api.clients.create, { name: "Bob Co" });
    const gone = await owner.mutation(api.clients.create, { name: "Gone" });
    await owner.mutation(api.clients.remove, { id: gone });

    const foreign = await owner.query(api.clients.get, { id: bobs }).catch((e) => e.data);
    const missing = await owner.query(api.clients.get, { id: gone }).catch((e) => e.data);
    expect(foreign).toMatchObject({ code: "NOT_FOUND" });
    expect(foreign).toEqual(missing);
  });
});

describe("list", () => {
  test("is newest first, paginated, and hides archived clients by default", async () => {
    const { owner } = setup();
    const ids = [];
    for (const name of ["First", "Second", "Third"]) {
      ids.push(await owner.mutation(api.clients.create, { name }));
    }
    await owner.mutation(api.clients.archive, { id: ids[1] });

    expect((await listAll(owner)).map((c) => c.name)).toEqual(["Third", "First"]);
    expect((await listAll(owner, { archived: true })).map((c) => c.name)).toEqual(["Second"]);

    const first = await owner.query(api.clients.list, { paginationOpts: page(1) });
    expect(first.page.map((c) => c.name)).toEqual(["Third"]);
    expect(first.isDone).toBe(false);
    const second = await owner.query(api.clients.list, {
      paginationOpts: page(1, first.continueCursor),
    });
    expect(second.page.map((c) => c.name)).toEqual(["First"]);
  });

  test("search finds by name, within one scope and one archived state", async () => {
    const { owner, bob } = setup();
    await owner.mutation(api.clients.create, { name: "Acme Corporation" });
    await owner.mutation(api.clients.create, { name: "Globex" });
    const archivedAcme = await owner.mutation(api.clients.create, { name: "Acme Archived" });
    await owner.mutation(api.clients.archive, { id: archivedAcme });
    await bob.mutation(api.clients.create, { name: "Acme Elsewhere" });

    expect((await listAll(owner, { search: "acme" })).map((c) => c.name)).toEqual([
      "Acme Corporation",
    ]);
    expect((await listAll(owner, { search: "acme", archived: true })).map((c) => c.name)).toEqual([
      "Acme Archived",
    ]);
    expect(await listAll(owner, { search: "nothing like it" })).toEqual([]);
  });

  test("a blank search is the plain list", async () => {
    const { owner } = setup();
    await owner.mutation(api.clients.create, { name: "A" });
    await owner.mutation(api.clients.create, { name: "B" });
    expect(await listAll(owner, { search: "   " })).toHaveLength(2);
  });

  test("never lists another scope's clients", async () => {
    const { owner, bob, personal } = setup();
    await owner.mutation(api.clients.create, { name: "Org A client" });
    await bob.mutation(api.clients.create, { name: "Org B client" });
    await personal.mutation(api.clients.create, { name: "Personal client" });
    expect((await listAll(owner)).map((c) => c.name)).toEqual(["Org A client"]);
    expect((await listAll(bob)).map((c) => c.name)).toEqual(["Org B client"]);
    expect((await listAll(personal)).map((c) => c.name)).toEqual(["Personal client"]);
  });
});

describe("update", () => {
  test("replaces the editable fields; omitted optional ones are cleared", async () => {
    const { t, owner } = setup();
    const id = await owner.mutation(api.clients.create, {
      name: "Acme",
      company: "Acme Ltd",
      email: "a@acme.com",
      phone: "555-0100",
      notes: "VIP",
      billingAddress: { line1: "1 Main St", city: "Pune", country: "IN" },
    });
    await owner.mutation(api.clients.update, { id, name: "Acme Renamed", email: "b@acme.com" });

    const row = await t.run((ctx) => ctx.db.get("clients", id));
    expect(row).toMatchObject({ name: "Acme Renamed", email: "b@acme.com" });
    expect(row?.company).toBeUndefined();
    expect(row?.phone).toBeUndefined();
    expect(row?.notes).toBeUndefined();
    expect(row?.billingAddress).toBeUndefined();
  });

  test("cannot touch balances, archive state or scope", async () => {
    const { t, owner } = setup();
    const id = await owner.mutation(api.clients.create, { name: "Acme" });
    await owner.mutation(m("createInvoice"), { clientId: id, status: "sent", totalCents: 700 });
    await owner.mutation(api.clients.archive, { id });
    await owner.mutation(api.clients.update, { id, name: "Renamed" });

    expect(await t.run((ctx) => ctx.db.get("clients", id))).toMatchObject({
      name: "Renamed",
      isArchived: true,
      outstandingCents: 700,
      scopeId: "org_A",
    });
  });

  test("records the change in the audit trail as a field diff", async () => {
    const { owner } = setup();
    const id = await owner.mutation(api.clients.create, { name: "Acme" });
    await owner.mutation(api.clients.update, { id, name: "Acme Ltd" });
    const log = await owner.query(api.audit.listAuditLog, { paginationOpts: page(10) });
    expect(log.page[0]).toMatchObject({
      action: "update",
      changes: [{ field: "name", from: "Acme", to: "Acme Ltd" }],
    });
  });

  test("another org's client cannot be edited", async () => {
    const { t, owner, bob } = setup();
    const bobs = await bob.mutation(api.clients.create, { name: "Bob Co" });
    await expect(
      owner.mutation(api.clients.update, { id: bobs, name: "Pwned" }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    expect((await t.run((ctx) => ctx.db.get("clients", bobs)))?.name).toBe("Bob Co");
  });

  test("the currency is locked once the client has invoices", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "business");
    const id = await owner.mutation(api.clients.create, { name: "Acme", currency: "EUR" });
    await rawInvoice(t, id);
    await expect(
      owner.mutation(api.clients.update, { id, name: "Acme", currency: "GBP" }),
    ).rejects.toMatchObject({ data: { code: "CONFLICT", reason: "client_currency_locked" } });
    // Saving the same currency is fine.
    await owner.mutation(api.clients.update, { id, name: "Acme 2", currency: "EUR" });
  });

  test("the currency can change before any invoice, subject to the plan", async () => {
    const { t, owner } = setup();
    const id = await owner.mutation(api.clients.create, { name: "Acme" });
    await expect(
      owner.mutation(api.clients.update, { id, name: "Acme", currency: "EUR" }),
    ).rejects.toMatchObject({ data: { code: "UPGRADE_REQUIRED", feature: "multi_currency" } });
    await subscribe(t, "org_A", "business");
    await owner.mutation(api.clients.update, { id, name: "Acme", currency: "EUR" });
    expect((await owner.query(api.clients.get, { id })).currency).toBe("EUR");
  });
});

describe("archive", () => {
  test("hides and restores a client, and still counts toward the quota", async () => {
    const { owner } = setup();
    const ids = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(await owner.mutation(api.clients.create, { name: `C${i}` }));
    }
    await owner.mutation(api.clients.archive, { id: ids[0] });
    expect(await listAll(owner)).toHaveLength(4);
    // An archived client keeps its slot, so a 6th is still refused.
    await expect(owner.mutation(api.clients.create, { name: "C6" })).rejects.toMatchObject({
      data: { code: "UPGRADE_REQUIRED" },
    });
    await owner.mutation(api.clients.unarchive, { id: ids[0] });
    expect(await listAll(owner)).toHaveLength(5);
  });

  test("is scoped", async () => {
    const { owner, bob } = setup();
    const bobs = await bob.mutation(api.clients.create, { name: "Bob Co" });
    await expect(owner.mutation(api.clients.archive, { id: bobs })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
  });
});

describe("remove", () => {
  test("deletes an unused client, frees its quota slot and audits it", async () => {
    const { owner } = setup();
    const ids = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(await owner.mutation(api.clients.create, { name: `C${i}` }));
    }
    await owner.mutation(api.clients.remove, { id: ids[0] });
    await owner.mutation(api.clients.create, { name: "Fits now" });

    const log = await owner.query(api.audit.listAuditLog, {
      paginationOpts: page(50),
      entity: { table: "clients", id: ids[0] },
    });
    expect(log.page.map((r) => r.action)).toEqual(["delete", "create"]);
  });

  test.each([
    [
      "invoices",
      (t: Ctx["t"], clientId: Id<"clients">) => rawInvoice(t, clientId),
    ],
    [
      "payments",
      (t: Ctx["t"], clientId: Id<"clients">) =>
        t.run(async (ctx) => {
          // The invoice belongs to a different client, so only the payment
          // references the client under test.
          const otherClient = await ctx.db.insert("clients", {
            scopeId: "org_A",
            scopeKind: "org",
            name: "Invoice owner",
            currency: "USD",
            isArchived: false,
            outstandingCents: 0,
            totalBilledCents: 0,
            totalPaidCents: 0,
          });
          const invoiceId = await ctx.db.insert("invoices", {
            scopeId: "org_A",
            scopeKind: "org",
            clientId: otherClient,
            invoiceNumber: "X",
            status: "draft",
            issueDate: 0,
            dueDate: 0,
            currency: "USD",
            subtotalCents: 0,
            taxCents: 0,
            discountCents: 0,
            totalCents: 0,
            paidCents: 0,
          });
          await ctx.db.insert("payments", {
            scopeId: "org_A",
            scopeKind: "org",
            invoiceId,
            clientId,
            amountCents: 1,
            paidAt: 0,
            method: "cash",
          });
        }),
    ],
    [
      "recurringInvoices",
      (t: Ctx["t"], clientId: Id<"clients">) =>
        t.run((ctx) =>
          ctx.db.insert("recurringInvoices", {
            scopeId: "org_A",
            scopeKind: "org",
            clientId,
            frequency: "monthly",
            startDate: 0,
            nextRunAt: 0,
            isActive: true,
            currency: "USD",
            paymentTermsDays: 30,
            discountCents: 0,
          }),
        ),
    ],
    [
      "expenses",
      (t: Ctx["t"], clientId: Id<"clients">) =>
        t.run(async (ctx) => {
          const categoryId = await ctx.db.insert("expenseCategories", {
            scopeId: "org_A",
            scopeKind: "org",
            name: "Other",
            isDefault: true,
          });
          await ctx.db.insert("expenses", {
            scopeId: "org_A",
            scopeKind: "org",
            categoryId,
            vendor: "V",
            amountCents: 1,
            taxCents: 0,
            currency: "USD",
            spentAt: 0,
            paymentMethod: "card",
            ocrStatus: "none",
            isBillable: true,
            clientId,
          });
        }),
    ],
  ])("is refused while %s still reference the client", async (blockedBy, attach) => {
    const { t, owner } = setup();
    const id = await owner.mutation(api.clients.create, { name: "Acme" });
    await attach(t, id);

    await expect(owner.mutation(api.clients.remove, { id })).rejects.toMatchObject({
      data: { code: "CONFLICT", reason: "client_has_records", blockedBy },
    });
    expect(await t.run((ctx) => ctx.db.get("clients", id))).not.toBeNull();
  });

  test("another org's client cannot be deleted", async () => {
    const { t, owner, bob } = setup();
    const bobs = await bob.mutation(api.clients.create, { name: "Bob Co" });
    await expect(owner.mutation(api.clients.remove, { id: bobs })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
    expect(await t.run((ctx) => ctx.db.get("clients", bobs))).not.toBeNull();
  });
});

describe("listInvoices", () => {
  test("is the client's own history, most recently issued first, paginated", async () => {
    const { t, owner } = setup();
    const acme = await owner.mutation(api.clients.create, { name: "Acme" });
    const other = await owner.mutation(api.clients.create, { name: "Other" });
    await rawInvoice(t, acme, 100);
    await rawInvoice(t, acme, 300);
    await rawInvoice(t, acme, 200);
    await rawInvoice(t, other, 999);

    const all = await owner.query(api.clients.listInvoices, {
      clientId: acme,
      paginationOpts: page(10),
    });
    expect(all.page.map((i) => i.issueDate)).toEqual([300, 200, 100]);

    const first = await owner.query(api.clients.listInvoices, {
      clientId: acme,
      paginationOpts: page(2),
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
  });

  test("another org's client history is not reachable", async () => {
    const { t, owner, bob } = setup();
    const bobs = await bob.mutation(api.clients.create, { name: "Bob Co" });
    await rawInvoice(t, bobs, 1, "org_B");
    await expect(
      owner.query(api.clients.listInvoices, { clientId: bobs, paginationOpts: page(10) }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });
});

describe("authentication", () => {
  test("every function needs a signed-in caller", async () => {
    const { t, owner } = setup();
    const id = await owner.mutation(api.clients.create, { name: "Acme" });
    const unauthenticated = { data: { code: "UNAUTHENTICATED" } };
    await expect(
      t.query(api.clients.list, { paginationOpts: page(10) }),
    ).rejects.toMatchObject(unauthenticated);
    await expect(t.query(api.clients.get, { id })).rejects.toMatchObject(unauthenticated);
    await expect(t.mutation(api.clients.create, { name: "X" })).rejects.toMatchObject(
      unauthenticated,
    );
    await expect(t.mutation(api.clients.remove, { id })).rejects.toMatchObject(unauthenticated);
  });
});
