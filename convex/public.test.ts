/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { line, newClient, newDraft, newSent, setup } from "./testkit.testutil";
import type { Ctx } from "./testkit.testutil";

const PUBLIC_KEYS = [
  "balanceCents",
  "client",
  "currency",
  "discountCents",
  "dueDate",
  "invoiceNumber",
  "issueDate",
  "lineItems",
  "notes",
  "paidAt",
  "paidCents",
  "sentAt",
  "seller",
  "status",
  "subtotalCents",
  "taxCents",
  "totalCents",
];

const row = (t: Ctx["t"], id: Id<"invoices">) => t.run((ctx) => ctx.db.get("invoices", id));
const view = (t: Ctx["t"], token: string) => t.query(api.public.getInvoiceByToken, { token });

/** Every key at every depth, so a leaked id anywhere shows up. */
function allKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, into));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

describe("getInvoiceByToken (no login)", () => {
  test("shows the invoice to someone who is not signed in", async () => {
    const { t, owner } = setup();
    const { publicToken } = await newSent(owner, {
      lineItems: [line({ description: "Design", quantity: 2, unitPriceCents: 5_000, taxRatePct: 10 })],
      notes: "Thank you",
    });
    const shown = await view(t, publicToken);
    expect(shown).toMatchObject({
      invoiceNumber: "INV-0001",
      status: "sent",
      currency: "USD",
      subtotalCents: 10_000,
      taxCents: 1_000,
      totalCents: 11_000,
      paidCents: 0,
      balanceCents: 11_000,
      notes: "Thank you",
      lineItems: [{ description: "Design", quantity: 2, unitPriceCents: 5_000, taxRatePct: 10, amountCents: 10_000 }],
      client: { name: "Acme", company: null, billingAddress: null },
    });
  });

  test("is a deliberately narrow projection: exactly these fields, no ids anywhere", async () => {
    const { t, owner } = setup();
    const { publicToken } = await newSent(owner);
    const shown = await view(t, publicToken);
    expect(Object.keys(shown!).sort()).toEqual([...PUBLIC_KEYS].sort());

    const keys = allKeys(shown);
    for (const forbidden of [
      "_id",
      "_creationTime",
      "scopeId",
      "scopeKind",
      "clientId",
      "invoiceId",
      "publicToken",
      "recurringTemplateId",
      "viewedAt",
      "exchangeRate",
      "email", // the client's email is not part of what they are shown
      "outstandingCents",
      "totalBilledCents",
    ]) {
      // `seller.email` is the seller's own contact address and is expected.
      if (forbidden === "email") continue;
      expect(keys.has(forbidden), `leaked ${forbidden}`).toBe(false);
    }
  });

  test("the client's contact details and other invoices are not exposed", async () => {
    const { t, owner } = setup();
    const clientId = await owner.mutation(api.clients.create, {
      name: "Acme",
      email: "private@acme.com",
      phone: "555-0100",
      notes: "internal note",
    });
    await newSent(owner, { clientId });
    const { publicToken } = await newSent(owner, { clientId });
    const json = JSON.stringify(await view(t, publicToken));
    expect(json).not.toContain("private@acme.com");
    expect(json).not.toContain("555-0100");
    expect(json).not.toContain("internal note");
    expect(json).not.toContain("INV-0001"); // the other invoice
  });

  test("shows who it is from, using the scope's settings", async () => {
    const { t, owner } = setup();
    const { publicToken } = await newSent(owner);
    await t.run(async (ctx) => {
      const s = await ctx.db.query("scopeSettings").first();
      await ctx.db.patch("scopeSettings", s!._id, {
        businessName: "Acme Books Ltd",
        email: "hello@acmebooks.com",
        taxId: "GB123",
        brandColor: "#0a7",
        footerNote: "Pay within 30 days",
        address: { line1: "1 High St", city: "London", country: "GB" },
      });
    });
    const shown = await view(t, publicToken);
    expect(shown?.seller).toMatchObject({
      businessName: "Acme Books Ltd",
      email: "hello@acmebooks.com",
      taxId: "GB123",
      brandColor: "#0a7",
      footerNote: "Pay within 30 days",
      address: { city: "London" },
      logoUrl: null,
    });
  });

  test("gives a URL for the logo when one is uploaded", async () => {
    const { t, owner } = setup();
    const { publicToken } = await newSent(owner);
    await t.run(async (ctx) => {
      const logoStorageId = await ctx.storage.store(new Blob(["png"]));
      const s = await ctx.db.query("scopeSettings").first();
      await ctx.db.patch("scopeSettings", s!._id, { logoStorageId });
    });
    expect(typeof (await view(t, publicToken))?.seller.logoUrl).toBe("string");
  });

  test("reflects payments as they are recorded", async () => {
    const { t, owner } = setup();
    const { invoiceId, publicToken } = await newSent(owner);
    await owner.mutation(api.invoices.recordPayment, {
      invoiceId,
      amountCents: 4_000,
      method: "cash",
    });
    expect(await view(t, publicToken)).toMatchObject({ paidCents: 4_000, balanceCents: 6_000 });
    await owner.mutation(api.invoices.recordPayment, { invoiceId, amountCents: 6_000, method: "cash" });
    expect(await view(t, publicToken)).toMatchObject({ status: "paid", balanceCents: 0 });
  });

  test("a voided invoice's link says so", async () => {
    const { t, owner } = setup();
    const { invoiceId, publicToken } = await newSent(owner);
    await owner.mutation(api.invoices.voidInvoice, { id: invoiceId });
    expect((await view(t, publicToken))?.status).toBe("void");
  });

  test.each([
    ["empty", ""],
    ["too short", "abc"],
    ["wrong length", "x".repeat(200)],
    ["right length, not a real token", "A".repeat(43)],
    ["illegal characters", `${"a".repeat(42)}=`],
    ["an id, not a token", "jd7a3xkq9n2m5b8v1c4z6"],
  ])("an unknown token (%s) is null", async (_label, token) => {
    const { t, owner } = setup();
    await newSent(owner);
    expect(await view(t, token)).toBeNull();
  });

  test("a draft is unreachable, even if a token were somehow attached", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await newDraft(owner);
    expect((await row(t, invoiceId))?.publicToken).toBeUndefined();
    const forced = "F".repeat(43);
    await t.run((ctx) => ctx.db.patch("invoices", invoiceId, { publicToken: forced }));
    expect(await view(t, forced)).toBeNull();
  });

  test("one invoice's token shows only that invoice", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    const a = await newSent(owner, { clientId, lineItems: [line({ unitPriceCents: 1_000 })] });
    const b = await newSent(owner, { clientId, lineItems: [line({ unitPriceCents: 2_000 })] });
    expect((await view(t, a.publicToken))?.totalCents).toBe(1_000);
    expect((await view(t, b.publicToken))?.totalCents).toBe(2_000);
  });

  test("works across tenants without a scope: each token opens its own org's invoice", async () => {
    const { t, owner, bob } = setup();
    const a = await newSent(owner);
    const b = await newSent(bob);
    expect((await view(t, a.publicToken))?.invoiceNumber).toBe("INV-0001");
    expect((await view(t, b.publicToken))?.invoiceNumber).toBe("INV-0001");
  });
});

describe("markViewed (no login)", () => {
  const mark = (t: Ctx["t"], token: string) => t.mutation(api.public.markViewed, { token });

  test("flips sent to viewed and stamps viewedAt", async () => {
    const { t, owner } = setup();
    const { invoiceId, publicToken } = await newSent(owner);
    await mark(t, publicToken);
    expect(await row(t, invoiceId)).toMatchObject({ status: "viewed" });
    expect((await row(t, invoiceId))?.viewedAt).toBeGreaterThan(0);
    expect((await view(t, publicToken))?.status).toBe("viewed");
  });

  test("is idempotent: later opens change nothing", async () => {
    const { t, owner } = setup();
    const { invoiceId, publicToken } = await newSent(owner);
    await mark(t, publicToken);
    const first = await row(t, invoiceId);
    await mark(t, publicToken);
    await mark(t, publicToken);
    expect(await row(t, invoiceId)).toEqual(first);
  });

  test("leaves the client's balances and the audit trail alone", async () => {
    const { t, owner } = setup();
    const { clientId, publicToken } = await newSent(owner);
    const before = await owner.query(api.clients.get, { id: clientId });
    const auditBefore = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    await mark(t, publicToken);
    expect(await owner.query(api.clients.get, { id: clientId })).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query("auditLogs").collect())).toHaveLength(auditBefore.length);
  });

  test("an overdue invoice keeps its status but records the first view once", async () => {
    const { t, owner } = setup();
    const { invoiceId, publicToken } = await newSent(owner);
    await t.run((ctx) => ctx.db.patch("invoices", invoiceId, { status: "overdue" }));
    await mark(t, publicToken);
    const first = await row(t, invoiceId);
    expect(first?.status).toBe("overdue");
    expect(first?.viewedAt).toBeGreaterThan(0);
    await mark(t, publicToken);
    expect((await row(t, invoiceId))?.viewedAt).toBe(first?.viewedAt);
  });

  test("a paid invoice keeps its status", async () => {
    const { t, owner } = setup();
    const { invoiceId, publicToken } = await newSent(owner);
    await owner.mutation(api.invoices.recordPayment, { invoiceId, amountCents: 10_000, method: "cash" });
    await mark(t, publicToken);
    expect((await row(t, invoiceId))?.status).toBe("paid");
  });

  test("a voided invoice is untouched", async () => {
    const { t, owner } = setup();
    const { invoiceId, publicToken } = await newSent(owner);
    await owner.mutation(api.invoices.voidInvoice, { id: invoiceId });
    const before = await row(t, invoiceId);
    await mark(t, publicToken);
    expect(await row(t, invoiceId)).toEqual(before);
  });

  test("unknown and malformed tokens are ignored without error", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await newSent(owner);
    const before = await row(t, invoiceId);
    for (const token of ["", "nope", "A".repeat(43), "x".repeat(500)]) await mark(t, token);
    expect(await row(t, invoiceId)).toEqual(before);
  });

  test("a draft cannot be marked viewed", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await newDraft(owner);
    const forced = "F".repeat(43);
    await t.run((ctx) => ctx.db.patch("invoices", invoiceId, { publicToken: forced }));
    await mark(t, forced);
    expect((await row(t, invoiceId))?.status).toBe("draft");
  });

  test("only the token's own invoice is affected", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    const a = await newSent(owner, { clientId });
    const b = await newSent(owner, { clientId });
    await mark(t, a.publicToken);
    expect((await row(t, a.invoiceId))?.status).toBe("viewed");
    expect((await row(t, b.invoiceId))?.status).toBe("sent");
  });
});
