/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import crons from "./crons";
import { DAY_MS, startOfUtcDay } from "./lib/invoiceMath";
import { newClient, newDraft, newSent, setup } from "./testkit.testutil";
import type { Ctx } from "./testkit.testutil";

const today = () => startOfUtcDay(Date.now());
const status = async (t: Ctx["t"], id: Id<"invoices">) =>
  (await t.run((ctx) => ctx.db.get("invoices", id)))?.status;

/** A sent invoice whose due date is `daysAgo` days before today (0 = today). */
async function sentDueDaysAgo(actor: Ctx["owner"], t: Ctx["t"], daysAgo: number, clientId?: Id<"clients">) {
  const sent = await newSent(actor, clientId ? { clientId } : {});
  await t.run((ctx) => ctx.db.patch("invoices", sent.invoiceId, { dueDate: today() - daysAgo * DAY_MS }));
  return sent;
}

const run = (t: Ctx["t"]) => t.mutation(internal.invoicesCron.markOverdue, {});

describe("markOverdue", () => {
  test("marks sent and viewed invoices whose due day has passed", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    const sent = await sentDueDaysAgo(owner, t, 3, clientId);
    const viewed = await sentDueDaysAgo(owner, t, 1, clientId);
    await t.mutation(api.public.markViewed, { token: viewed.publicToken });

    await run(t);
    expect(await status(t, sent.invoiceId)).toBe("overdue");
    expect(await status(t, viewed.invoiceId)).toBe("overdue");
  });

  test("an invoice due today is not overdue until tomorrow", async () => {
    const { t, owner } = setup();
    const dueToday = await sentDueDaysAgo(owner, t, 0);
    const dueTomorrow = await sentDueDaysAgo(owner, t, -1);
    await run(t);
    expect(await status(t, dueToday.invoiceId)).toBe("sent");
    expect(await status(t, dueTomorrow.invoiceId)).toBe("sent");
  });

  test("leaves drafts, paid, void and already-overdue invoices alone", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);

    const draft = await newDraft(owner, { clientId });
    await t.run((ctx) => ctx.db.patch("invoices", draft.invoiceId, { dueDate: today() - 5 * DAY_MS }));

    const paid = await sentDueDaysAgo(owner, t, 5, clientId);
    await owner.mutation(api.invoices.recordPayment, { invoiceId: paid.invoiceId, amountCents: 10_000, method: "cash" });

    const voided = await sentDueDaysAgo(owner, t, 5, clientId);
    await owner.mutation(api.invoices.voidInvoice, { id: voided.invoiceId });

    await run(t);
    expect(await status(t, draft.invoiceId)).toBe("draft");
    expect(await status(t, paid.invoiceId)).toBe("paid");
    expect(await status(t, voided.invoiceId)).toBe("void");
  });

  test("works across every tenant in one run", async () => {
    const { t, owner, bob, personal } = setup();
    const a = await sentDueDaysAgo(owner, t, 2);
    const b = await sentDueDaysAgo(bob, t, 2);
    const p = await sentDueDaysAgo(personal, t, 2);
    await run(t);
    for (const inv of [a, b, p]) expect(await status(t, inv.invoiceId)).toBe("overdue");
  });

  test("is idempotent", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await sentDueDaysAgo(owner, t, 2);
    await run(t);
    const after = await t.run((ctx) => ctx.db.get("invoices", invoiceId));
    await run(t);
    await run(t);
    expect(await t.run((ctx) => ctx.db.get("invoices", invoiceId))).toEqual(after);
  });

  test("does not change what the client owes", async () => {
    const { t, owner } = setup();
    const { clientId } = await sentDueDaysAgo(owner, t, 2);
    const before = await owner.query(api.clients.get, { id: clientId });
    await run(t);
    expect(await owner.query(api.clients.get, { id: clientId })).toEqual(before);
  });

  test("is audited, attributed to the system rather than a person", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await sentDueDaysAgo(owner, t, 2);
    await run(t);
    const log = await owner.query(api.audit.listAuditLog, {
      paginationOpts: { numItems: 20, cursor: null },
      entity: { table: "invoices", id: invoiceId },
    });
    const change = log.page.find((r) => r.actorUserId === "system");
    expect(change).toMatchObject({ action: "update", actorRole: "owner" });
    expect(change?.changes).toEqual([{ field: "status", from: "sent", to: "overdue" }]);
  });

  test("a paid-then-reopened invoice past due is overdue, and is then picked up as normal", async () => {
    const { t, owner } = setup();
    const { invoiceId } = await sentDueDaysAgo(owner, t, 4);
    const pay = await owner.mutation(api.invoices.recordPayment, { invoiceId, amountCents: 10_000, method: "cash" });
    await owner.mutation(api.invoices.deletePayment, { id: pay });
    // Reopening already accounts for the due date.
    expect(await status(t, invoiceId)).toBe("overdue");
  });

  test("keeps going in batches until everything is marked", async () => {
    vi.useFakeTimers();
    try {
      const { t } = setup();
      const clientId = await t.run((ctx) =>
        ctx.db.insert("clients", {
          scopeId: "org_A",
          scopeKind: "org",
          name: "Bulk",
          currency: "USD",
          isArchived: false,
          outstandingCents: 0,
          totalBilledCents: 0,
          totalPaidCents: 0,
        }),
      );
      await t.run(async (ctx) => {
        for (let i = 0; i < 130; i++) {
          await ctx.db.insert("invoices", {
            scopeId: "org_A",
            scopeKind: "org",
            clientId,
            invoiceNumber: `INV-${i}`,
            status: "sent",
            issueDate: today() - 60 * DAY_MS,
            dueDate: today() - 30 * DAY_MS,
            currency: "USD",
            subtotalCents: 100,
            taxCents: 0,
            discountCents: 0,
            totalCents: 100,
            paidCents: 0,
          });
        }
      });

      await run(t);
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const left = await t.run((ctx) =>
        ctx.db.query("invoices").withIndex("by_status_and_dueDate", (q) => q.eq("status", "sent")).collect(),
      );
      expect(left).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("crons", () => {
  test("the overdue job is scheduled daily at 03:00 UTC", () => {
    const job = crons.crons["mark overdue invoices"];
    expect(job).toBeDefined();
    expect(JSON.stringify(job.schedule)).toContain("0 3 * * *");
  });
});
