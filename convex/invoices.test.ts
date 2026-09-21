/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DAY_MS, startOfUtcDay } from "./lib/invoiceMath";
import {
  DAY,
  line,
  newClient,
  newDraft,
  newSent,
  page,
  setup,
  subscribe,
} from "./testkit.testutil";
import type { Actor, Ctx } from "./testkit.testutil";

const balances = async (actor: Actor, id: Id<"clients">) => {
  const c = await actor.query(api.clients.get, { id });
  return { billed: c.totalBilledCents, paid: c.totalPaidCents, outstanding: c.outstandingCents };
};
const invoiceRow = (t: Ctx["t"], id: Id<"invoices">) => t.run((ctx) => ctx.db.get("invoices", id));
const payArgs = (invoiceId: Id<"invoices">, amountCents: number, over = {}) => ({
  invoiceId,
  amountCents,
  method: "bank_transfer",
  ...over,
});

describe("create", () => {
  test("stores a draft in the caller's scope with server-computed totals", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    const id = await owner.mutation(api.invoices.create, {
      clientId,
      discountCents: 500,
      notes: "  Thanks!  ",
      lineItems: [
        line({ description: "Design", quantity: 2, unitPriceCents: 10_000, taxRatePct: 10 }),
        line({ description: "Hosting", unitPriceCents: 5_000, taxRatePct: 0 }),
      ],
    });

    expect(await invoiceRow(t, id)).toMatchObject({
      scopeId: "org_A",
      scopeKind: "org",
      clientId,
      status: "draft",
      currency: "USD",
      subtotalCents: 25_000,
      taxCents: 2_000,
      discountCents: 500,
      totalCents: 26_500,
      paidCents: 0,
      notes: "Thanks!",
    });
    const lines = await t.run((ctx) => ctx.db.query("invoiceLineItems").collect());
    expect(lines.map((l) => [l.position, l.description, l.amountCents])).toEqual([
      [0, "Design", 20_000],
      [1, "Hosting", 5_000],
    ]);
  });

  test("there is no way to send a total: extra arguments are rejected", async () => {
    const { owner } = setup();
    const clientId = await newClient(owner);
    for (const extra of [{ totalCents: 1 }, { subtotalCents: 1 }, { status: "paid" }, { scopeId: "org_B" }]) {
      await expect(
        owner.mutation(api.invoices.create, { clientId, lineItems: [line()], ...extra } as never),
      ).rejects.toThrow();
    }
  });

  test("numbers run INV-0001, INV-0002 and advance the sequence", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    const a = await newDraft(owner, { clientId });
    const b = await newDraft(owner, { clientId });
    expect((await invoiceRow(t, a.invoiceId))?.invoiceNumber).toBe("INV-0001");
    expect((await invoiceRow(t, b.invoiceId))?.invoiceNumber).toBe("INV-0002");
    const settings = await t.run((ctx) => ctx.db.query("scopeSettings").first());
    expect(settings?.nextInvoiceSeq).toBe(3);
  });

  test("uses the scope's prefix and sequence", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    await newDraft(owner, { clientId }); // creates the settings
    await t.run(async (ctx) => {
      const s = await ctx.db.query("scopeSettings").first();
      await ctx.db.patch("scopeSettings", s!._id, { invoiceNumberPrefix: "ACME-", nextInvoiceSeq: 250 });
    });
    const { invoiceId } = await newDraft(owner, { clientId });
    expect((await invoiceRow(t, invoiceId))?.invoiceNumber).toBe("ACME-0250");
  });

  test("skips a number that is already taken instead of colliding", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    const first = await newDraft(owner, { clientId });
    await t.run(async (ctx) => {
      const s = await ctx.db.query("scopeSettings").first();
      await ctx.db.patch("scopeSettings", s!._id, { nextInvoiceSeq: 1 }); // rewind onto INV-0001
    });
    const { invoiceId } = await newDraft(owner, { clientId });
    expect((await invoiceRow(t, invoiceId))?.invoiceNumber).toBe("INV-0002");
    expect((await invoiceRow(t, first.invoiceId))?.invoiceNumber).toBe("INV-0001");
  });

  test("each scope numbers independently", async () => {
    const { t, owner, bob } = setup();
    const a = await newDraft(owner);
    const b = await newDraft(bob);
    expect((await invoiceRow(t, a.invoiceId))?.invoiceNumber).toBe("INV-0001");
    expect((await invoiceRow(t, b.invoiceId))?.invoiceNumber).toBe("INV-0001");
  });

  test("dates default to today and the payment terms; explicit ones snap to the day", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await newDraft(owner);
    const today = startOfUtcDay(Date.now());
    expect(await invoiceRow(t, invoiceId)).toMatchObject({
      issueDate: today,
      dueDate: today + 30 * DAY_MS,
    });

    const clientId = await newClient(owner, "Other");
    const explicit = await owner.mutation(api.invoices.create, {
      clientId,
      issueDate: Date.UTC(2026, 0, 5, 14),
      dueDate: Date.UTC(2026, 0, 19, 9),
      lineItems: [line()],
    });
    expect(await invoiceRow(t, explicit)).toMatchObject({
      issueDate: Date.UTC(2026, 0, 5),
      dueDate: Date.UTC(2026, 0, 19),
    });
  });

  test("rejects bad input with a typed error naming the field", async () => {
    const { owner } = setup();
    const clientId = await newClient(owner);
    await expect(
      owner.mutation(api.invoices.create, { clientId, lineItems: [] }),
    ).rejects.toMatchObject({ data: { code: "INVALID_INPUT", field: "lineItems" } });
    await expect(
      owner.mutation(api.invoices.create, { clientId, lineItems: [line({ quantity: 0 })] }),
    ).rejects.toMatchObject({ data: { code: "INVALID_INPUT", field: "lineItems.0.quantity" } });
    await expect(
      owner.mutation(api.invoices.create, {
        clientId,
        issueDate: Date.UTC(2026, 5, 2),
        dueDate: Date.UTC(2026, 5, 1),
        lineItems: [line()],
      }),
    ).rejects.toMatchObject({ data: { code: "INVALID_INPUT", field: "dueDate" } });
  });

  test("a client from another org is NOT_FOUND; an archived one is a conflict", async () => {
    const { owner, bob } = setup();
    const bobs = await newClient(bob, "Bob Co");
    await expect(
      owner.mutation(api.invoices.create, { clientId: bobs, lineItems: [line()] }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });

    const mine = await newClient(owner);
    await owner.mutation(api.clients.archive, { id: mine });
    await expect(
      owner.mutation(api.invoices.create, { clientId: mine, lineItems: [line()] }),
    ).rejects.toMatchObject({ data: { code: "CONFLICT", reason: "client_archived" } });
  });

  test("the 11th invoice of the month on Free is refused, and consumes no number", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    for (let i = 0; i < 10; i++) await newDraft(owner, { clientId });

    await expect(
      owner.mutation(api.invoices.create, { clientId, lineItems: [line()] }),
    ).rejects.toMatchObject({
      data: { code: "UPGRADE_REQUIRED", reason: "quota", metric: "invoices", limit: 10 },
    });
    const settings = await t.run((ctx) => ctx.db.query("scopeSettings").first());
    expect(settings?.nextInvoiceSeq).toBe(11);
    expect(await t.run((ctx) => ctx.db.query("invoices").collect())).toHaveLength(10);
  });

  test("a client in another currency needs multi-currency and an exchange rate", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "business");
    const eur = await owner.mutation(api.clients.create, { name: "Euro Co", currency: "EUR" });

    await expect(
      owner.mutation(api.invoices.create, { clientId: eur, lineItems: [line()] }),
    ).rejects.toMatchObject({ data: { code: "INVALID_INPUT", field: "exchangeRate" } });
    await expect(
      owner.mutation(api.invoices.create, { clientId: eur, exchangeRate: 0, lineItems: [line()] }),
    ).rejects.toMatchObject({ data: { field: "exchangeRate" } });

    const id = await owner.mutation(api.invoices.create, {
      clientId: eur,
      exchangeRate: 1.08,
      lineItems: [line()],
    });
    expect(await invoiceRow(t, id)).toMatchObject({ currency: "EUR", exchangeRate: 1.08 });
  });

  test("dropping to Free blocks new foreign-currency invoices", async () => {
    const { t, owner } = setup();
    const eur = await t.run((ctx) =>
      ctx.db.insert("clients", {
        scopeId: "org_A",
        scopeKind: "org",
        name: "Euro Co",
        currency: "EUR",
        isArchived: false,
        outstandingCents: 0,
        totalBilledCents: 0,
        totalPaidCents: 0,
      }),
    );
    await expect(
      owner.mutation(api.invoices.create, { clientId: eur, exchangeRate: 1.1, lineItems: [line()] }),
    ).rejects.toMatchObject({
      data: { code: "UPGRADE_REQUIRED", feature: "multi_currency" },
    });
  });

  test("a base-currency client ignores a stray exchange rate", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await newDraft(owner, { exchangeRate: 2 });
    expect((await invoiceRow(t, invoiceId))?.exchangeRate).toBeUndefined();
  });

  test("a draft does not touch the client's balances", async () => {
    const { owner } = setup();
    const { clientId } = await newDraft(owner);
    expect(await balances(owner, clientId)).toEqual({ billed: 0, paid: 0, outstanding: 0 });
  });

  test("is audited without create calling anything", async () => {
    const { owner } = setup();
    const { invoiceId } = await newDraft(owner);
    const log = await owner.query(api.audit.listAuditLog, {
      paginationOpts: page(20),
      entity: { table: "invoices", id: invoiceId },
    });
    expect(log.page).toMatchObject([{ action: "create", entityLabel: "INV-0001" }]);
  });

  test("a viewer is refused; an accountant may create", async () => {
    const { owner, viewer, accountant } = setup();
    const clientId = await newClient(owner);
    await expect(
      viewer.mutation(api.invoices.create, { clientId, lineItems: [line()] }),
    ).rejects.toMatchObject({ data: { code: "FORBIDDEN", capability: "invoices.write" } });
    await accountant.mutation(api.invoices.create, { clientId, lineItems: [line()] });
  });
});

describe("update and remove (drafts only)", () => {
  test("update replaces the lines and recomputes the totals", async () => {
    const { t, owner } = setup();
    const { clientId, invoiceId } = await newDraft(owner);
    await owner.mutation(api.invoices.update, {
      id: invoiceId,
      clientId,
      lineItems: [line({ unitPriceCents: 2_000, quantity: 3 }), line({ description: "Extra", unitPriceCents: 500 })],
    });
    expect(await invoiceRow(t, invoiceId)).toMatchObject({ subtotalCents: 6_500, totalCents: 6_500 });
    const lines = await t.run((ctx) => ctx.db.query("invoiceLineItems").collect());
    expect(lines).toHaveLength(2);
  });

  test("update can move a draft to another client and keeps its number", async () => {
    const { t, owner } = setup();
    const { clientId, invoiceId } = await newDraft(owner);
    const other = await newClient(owner, "Other");
    await owner.mutation(api.invoices.update, { id: invoiceId, clientId: other, lineItems: [line()] });
    expect(await invoiceRow(t, invoiceId)).toMatchObject({ clientId: other, invoiceNumber: "INV-0001" });
    expect(clientId).not.toBe(other);
  });

  test("a sent invoice cannot be edited or deleted", async () => {
    const { owner } = setup();
    const { clientId, invoiceId } = await newSent(owner);
    await expect(
      owner.mutation(api.invoices.update, { id: invoiceId, clientId, lineItems: [line()] }),
    ).rejects.toMatchObject({ data: { code: "CONFLICT", reason: "invoice_not_editable", status: "sent" } });
    await expect(owner.mutation(api.invoices.remove, { id: invoiceId })).rejects.toMatchObject({
      data: { code: "CONFLICT", reason: "invoice_not_deletable" },
    });
  });

  test("remove deletes the draft and its lines and frees the quota slot", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push((await newDraft(owner, { clientId })).invoiceId);
    await expect(owner.mutation(api.invoices.create, { clientId, lineItems: [line()] })).rejects.toThrow();

    await owner.mutation(api.invoices.remove, { id: ids[0] });
    expect(await t.run((ctx) => ctx.db.query("invoiceLineItems").collect())).toHaveLength(9);
    await owner.mutation(api.invoices.create, { clientId, lineItems: [line()] });
  });

  test("another org's invoice cannot be edited or deleted", async () => {
    const { t, owner, bob } = setup();
    const { clientId: bobsClient, invoiceId } = await newDraft(bob);
    await expect(
      owner.mutation(api.invoices.update, { id: invoiceId, clientId: bobsClient, lineItems: [line()] }),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(owner.mutation(api.invoices.remove, { id: invoiceId })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
    expect(await invoiceRow(t, invoiceId)).not.toBeNull();
  });
});

describe("send", () => {
  test("flips to sent, stamps sentAt and mints an unguessable token", async () => {
    const { t, owner } = setup();
    const { invoiceId, publicToken } = await newSent(owner);
    expect(publicToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await invoiceRow(t, invoiceId)).toMatchObject({ status: "sent", publicToken });
    expect((await invoiceRow(t, invoiceId))?.sentAt).toBeGreaterThan(0);
  });

  test("every invoice gets its own token", async () => {
    const { owner } = setup();
    const clientId = await newClient(owner);
    const a = await newSent(owner, { clientId });
    const b = await newSent(owner, { clientId });
    expect(a.publicToken).not.toBe(b.publicToken);
  });

  test("bills the client", async () => {
    const { owner } = setup();
    const { clientId } = await newSent(owner, { lineItems: [line({ unitPriceCents: 7_000 })] });
    expect(await balances(owner, clientId)).toEqual({ billed: 7_000, paid: 0, outstanding: 7_000 });
  });

  test("cannot be sent twice", async () => {
    const { owner } = setup();
    const { invoiceId } = await newSent(owner);
    await expect(owner.mutation(api.invoices.send, { id: invoiceId })).rejects.toMatchObject({
      data: { code: "INVALID_TRANSITION", from: "sent", to: "sent" },
    });
  });

  test("an invoice with nothing to pay cannot be sent", async () => {
    const { owner } = setup();
    const { invoiceId } = await newDraft(owner, { discountCents: 10_000 });
    await expect(owner.mutation(api.invoices.send, { id: invoiceId })).rejects.toMatchObject({
      data: { code: "INVALID_INPUT", field: "totalCents" },
    });
  });

  test("a viewer cannot send; another org's invoice is NOT_FOUND", async () => {
    const { owner, viewer, bob } = setup();
    const { invoiceId } = await newDraft(owner);
    await expect(viewer.mutation(api.invoices.send, { id: invoiceId })).rejects.toMatchObject({
      data: { code: "FORBIDDEN", capability: "invoices.send" },
    });
    await expect(bob.mutation(api.invoices.send, { id: invoiceId })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
  });
});

describe("void", () => {
  test("voids a sent invoice and takes it out of the client's balances", async () => {
    const { t, owner } = setup();
    const { clientId, invoiceId } = await newSent(owner);
    await owner.mutation(api.invoices.voidInvoice, { id: invoiceId });
    expect((await invoiceRow(t, invoiceId))?.status).toBe("void");
    expect(await balances(owner, clientId)).toEqual({ billed: 0, paid: 0, outstanding: 0 });
  });

  test("void is terminal, and drafts and paid invoices cannot be voided", async () => {
    const { owner } = setup();
    const draft = await newDraft(owner);
    await expect(owner.mutation(api.invoices.voidInvoice, { id: draft.invoiceId })).rejects.toMatchObject({
      data: { code: "INVALID_TRANSITION" },
    });

    const paid = await newSent(owner);
    await owner.mutation(api.invoices.recordPayment, payArgs(paid.invoiceId, 10_000));
    await expect(owner.mutation(api.invoices.voidInvoice, { id: paid.invoiceId })).rejects.toMatchObject({
      data: { code: "INVALID_TRANSITION", from: "paid" },
    });

    const sent = await newSent(owner);
    await owner.mutation(api.invoices.voidInvoice, { id: sent.invoiceId });
    await expect(owner.mutation(api.invoices.voidInvoice, { id: sent.invoiceId })).rejects.toMatchObject({
      data: { code: "INVALID_TRANSITION", from: "void" },
    });
  });
});

describe("payments", () => {
  test("a partial payment leaves the invoice open and moves the balances", async () => {
    const { t, owner } = setup();
    const { clientId, invoiceId } = await newSent(owner);
    await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 4_000, { reference: " chq 12 " }));

    expect(await invoiceRow(t, invoiceId)).toMatchObject({ status: "sent", paidCents: 4_000 });
    expect(await balances(owner, clientId)).toEqual({ billed: 10_000, paid: 4_000, outstanding: 6_000 });
    const [payment] = await t.run((ctx) => ctx.db.query("payments").collect());
    expect(payment).toMatchObject({ clientId, amountCents: 4_000, method: "bank_transfer", reference: "chq 12" });
  });

  test("covering the total marks it paid and stamps paidAt", async () => {
    const { t, owner } = setup();
    const { clientId, invoiceId } = await newSent(owner);
    await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 6_000));
    await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 4_000, { paidAt: 1_700_000_000_000 }));

    expect(await invoiceRow(t, invoiceId)).toMatchObject({
      status: "paid",
      paidCents: 10_000,
      paidAt: 1_700_000_000_000,
    });
    expect(await balances(owner, clientId)).toEqual({ billed: 10_000, paid: 10_000, outstanding: 0 });
  });

  test("an overdue invoice can be paid", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await newSent(owner);
    await t.run((ctx) => ctx.db.patch("invoices", invoiceId, { status: "overdue" }));
    await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 10_000));
    expect((await invoiceRow(t, invoiceId))?.status).toBe("paid");
  });

  test("more than is owed is refused and stores nothing", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await newSent(owner);
    await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 9_000));
    await expect(
      owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 1_001)),
    ).rejects.toMatchObject({ data: { code: "INVALID_INPUT", field: "amountCents" } });
    expect(await t.run((ctx) => ctx.db.query("payments").collect())).toHaveLength(1);
    expect((await invoiceRow(t, invoiceId))?.paidCents).toBe(9_000);
  });

  test.each([0, -5, 10.5, Number.NaN])("an amount of %j is refused", async (amount) => {
    const { owner } = setup();
    const { invoiceId } = await newSent(owner);
    await expect(
      owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, amount)),
    ).rejects.toMatchObject({ data: { field: "amountCents" } });
  });

  test("a blank method is refused", async () => {
    const { owner } = setup();
    const { invoiceId } = await newSent(owner);
    await expect(
      owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 100, { method: "  " })),
    ).rejects.toMatchObject({ data: { field: "method" } });
  });

  test("only open invoices take payments", async () => {
    const { owner } = setup();
    const draft = await newDraft(owner);
    await expect(
      owner.mutation(api.invoices.recordPayment, payArgs(draft.invoiceId, 100)),
    ).rejects.toMatchObject({ data: { code: "CONFLICT", reason: "invoice_not_payable", status: "draft" } });

    const voided = await newSent(owner);
    await owner.mutation(api.invoices.voidInvoice, { id: voided.invoiceId });
    await expect(
      owner.mutation(api.invoices.recordPayment, payArgs(voided.invoiceId, 100)),
    ).rejects.toMatchObject({ data: { reason: "invoice_not_payable", status: "void" } });

    const paid = await newSent(owner);
    await owner.mutation(api.invoices.recordPayment, payArgs(paid.invoiceId, 10_000));
    await expect(
      owner.mutation(api.invoices.recordPayment, payArgs(paid.invoiceId, 1)),
    ).rejects.toMatchObject({ data: { reason: "invoice_not_payable", status: "paid" } });
  });

  test("a viewer cannot record or delete payments", async () => {
    const { owner, viewer } = setup();
    const { invoiceId } = await newSent(owner);
    const paymentId = await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 100));
    const forbidden = { data: { code: "FORBIDDEN", capability: "payments.record" } };
    await expect(viewer.mutation(api.invoices.recordPayment, payArgs(invoiceId, 100))).rejects.toMatchObject(forbidden);
    await expect(viewer.mutation(api.invoices.deletePayment, { id: paymentId })).rejects.toMatchObject(forbidden);
  });

  test("another org's invoice and payment are out of reach", async () => {
    const { owner, bob } = setup();
    const { invoiceId } = await newSent(bob);
    const paymentId = await bob.mutation(api.invoices.recordPayment, payArgs(invoiceId, 100));
    await expect(
      owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 100)),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(owner.mutation(api.invoices.deletePayment, { id: paymentId })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
  });

  describe("deleting one reopens a paid invoice", () => {
    test("to sent when it was never viewed", async () => {
      const { t, owner } = setup();
      const { clientId, invoiceId } = await newSent(owner);
      const pay = await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 10_000));
      await owner.mutation(api.invoices.deletePayment, { id: pay });
      expect(await invoiceRow(t, invoiceId)).toMatchObject({ status: "sent", paidCents: 0 });
      expect((await invoiceRow(t, invoiceId))?.paidAt).toBeUndefined();
      expect(await balances(owner, clientId)).toEqual({ billed: 10_000, paid: 0, outstanding: 10_000 });
    });

    test("to viewed when the client had opened it", async () => {
      const { t, owner } = setup();
      const { invoiceId } = await newSent(owner);
      await t.run((ctx) => ctx.db.patch("invoices", invoiceId, { viewedAt: Date.now() }));
      const pay = await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 10_000));
      await owner.mutation(api.invoices.deletePayment, { id: pay });
      expect((await invoiceRow(t, invoiceId))?.status).toBe("viewed");
    });

    test("to overdue when it is past due", async () => {
      const { t, owner } = setup();
      const { invoiceId } = await newSent(owner);
      await t.run((ctx) => ctx.db.patch("invoices", invoiceId, { dueDate: startOfUtcDay(Date.now()) - 5 * DAY }));
      const pay = await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 10_000));
      await owner.mutation(api.invoices.deletePayment, { id: pay });
      expect((await invoiceRow(t, invoiceId))?.status).toBe("overdue");
    });

    test("even when it was one of several payments, if the rest no longer cover it", async () => {
      const { t, owner } = setup();
      const { invoiceId } = await newSent(owner);
      await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 5_000));
      const second = await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 5_000));
      await owner.mutation(api.invoices.deletePayment, { id: second });
      // 5,000 of 10,000 is no longer covered, so it reopens.
      expect((await invoiceRow(t, invoiceId))?.status).toBe("sent");
      expect((await invoiceRow(t, invoiceId))?.paidCents).toBe(5_000);
    });
  });

  test("the payment's effect on the invoice is audited under the payer", async () => {
    const { owner } = setup();
    const { invoiceId } = await newSent(owner);
    await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 4_000));
    const log = await owner.query(api.audit.listAuditLog, {
      paginationOpts: page(20),
      entity: { table: "invoices", id: invoiceId },
    });
    const fields = log.page.flatMap((r) => r.changes ?? []).map((c) => c.field);
    expect(fields).toContain("paidCents");
    expect(fields).toContain("status");
  });
});

describe("list and get", () => {
  test("list is newest issued first, with the client's name and the balance", async () => {
    const { owner } = setup();
    const acme = await newClient(owner, "Acme");
    for (const [i, issueDate] of [Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 1), Date.UTC(2026, 1, 1)].entries()) {
      await newDraft(owner, { clientId: acme, issueDate, lineItems: [line({ unitPriceCents: 1000 * (i + 1) })] });
    }
    const result = await owner.query(api.invoices.list, { paginationOpts: page(10) });
    expect(result.page.map((i) => i.issueDate)).toEqual([
      Date.UTC(2026, 2, 1),
      Date.UTC(2026, 1, 1),
      Date.UTC(2026, 0, 1),
    ]);
    expect(result.page[0]).toMatchObject({ clientName: "Acme", balanceCents: 2000 });
  });

  test("list rows never carry the link token", async () => {
    const { owner } = setup();
    await newSent(owner);
    const [row] = (await owner.query(api.invoices.list, { paginationOpts: page(10) })).page;
    expect(row).not.toHaveProperty("publicToken");
  });

  test("list filters by status, by client, and by both", async () => {
    const { owner } = setup();
    const a = await newClient(owner, "A");
    const b = await newClient(owner, "B");
    await newDraft(owner, { clientId: a });
    await newSent(owner, { clientId: a });
    await newSent(owner, { clientId: b });

    const count = async (args: object) =>
      (await owner.query(api.invoices.list, { paginationOpts: page(20), ...args })).page.length;
    expect(await count({ status: "sent" })).toBe(2);
    expect(await count({ status: "draft" })).toBe(1);
    expect(await count({ clientId: a })).toBe(2);
    expect(await count({ clientId: a, status: "sent" })).toBe(1);
    expect(await count({ clientId: b, status: "draft" })).toBe(0);
  });

  test("list paginates", async () => {
    const { owner } = setup();
    const clientId = await newClient(owner);
    for (let i = 0; i < 3; i++) await newDraft(owner, { clientId });
    const first = await owner.query(api.invoices.list, { paginationOpts: page(2) });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const second = await owner.query(api.invoices.list, { paginationOpts: page(2, first.continueCursor) });
    expect(second.page).toHaveLength(1);
  });

  test("list never shows another scope's invoices", async () => {
    const { owner, bob, personal } = setup();
    await newDraft(owner);
    await newDraft(bob);
    await newDraft(personal);
    for (const actor of [owner, bob, personal]) {
      expect((await actor.query(api.invoices.list, { paginationOpts: page(10) })).page).toHaveLength(1);
    }
  });

  test("get returns the invoice with lines, payments, client and the link token", async () => {
    const { owner } = setup();
    const { invoiceId, publicToken } = await newSent(owner, {
      lineItems: [line({ description: "A" }), line({ description: "B", unitPriceCents: 500 })],
    });
    await owner.mutation(api.invoices.recordPayment, payArgs(invoiceId, 3_000));

    const got = await owner.query(api.invoices.get, { id: invoiceId });
    expect(got.invoice).toMatchObject({ status: "sent", publicToken, totalCents: 10_500 });
    expect(got.balanceCents).toBe(7_500);
    expect(got.lineItems.map((l) => l.description)).toEqual(["A", "B"]);
    expect(got.payments).toMatchObject([{ amountCents: 3_000 }]);
    expect(got.client).toMatchObject({ name: "Acme", currency: "USD" });
  });

  test("a viewer can read; another org's invoice is NOT_FOUND", async () => {
    const { owner, viewer, bob } = setup();
    const { invoiceId } = await newSent(owner);
    expect((await viewer.query(api.invoices.get, { id: invoiceId })).invoice.status).toBe("sent");
    expect((await viewer.query(api.invoices.list, { paginationOpts: page(10) })).page).toHaveLength(1);
    await expect(bob.query(api.invoices.get, { id: invoiceId })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
  });

  test("every function needs a signed-in caller", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await newSent(owner);
    const no = { data: { code: "UNAUTHENTICATED" } };
    await expect(t.query(api.invoices.list, { paginationOpts: page(10) })).rejects.toMatchObject(no);
    await expect(t.query(api.invoices.get, { id: invoiceId })).rejects.toMatchObject(no);
    await expect(t.mutation(api.invoices.send, { id: invoiceId })).rejects.toMatchObject(no);
    await expect(t.mutation(api.invoices.recordPayment, payArgs(invoiceId, 1))).rejects.toMatchObject(no);
  });
});
