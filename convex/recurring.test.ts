/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DAY_MS, startOfUtcDay } from "./lib/dates";
import { occurrence, occurrenceAfter } from "./lib/recurrence";
import crons from "./crons";
import { DAY, line, newClient, page, setup, subscribe } from "./testkit.testutil";
import type { Ctx } from "./testkit.testutil";

const today = () => startOfUtcDay(Date.now());
const run = (t: Ctx["t"]) => t.mutation(internal.recurringCron.generateDue, {});
const row = (t: Ctx["t"], id: Id<"recurringInvoices">) => t.run((ctx) => ctx.db.get("recurringInvoices", id));
const invoices = (t: Ctx["t"]) => t.run((ctx) => ctx.db.query("invoices").collect());

const tpl = (clientId: Id<"clients">, over: Record<string, unknown> = {}) =>
  ({
    clientId,
    frequency: "monthly",
    startDate: today(),
    lineItems: [line({ unitPriceCents: 25_000 })],
    ...over,
  }) as never;

async function newTemplate(actor: Ctx["owner"], over: Record<string, unknown> = {}) {
  const clientId = (over.clientId as Id<"clients"> | undefined) ?? (await newClient(actor));
  const id = await actor.mutation(api.recurring.create, tpl(clientId, over));
  return { clientId, id };
}

describe("feature gate", () => {
  test("creating a template on Free is refused, naming the plan that unlocks it", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    await expect(owner.mutation(api.recurring.create, tpl(clientId))).rejects.toMatchObject({
      data: { code: "UPGRADE_REQUIRED", reason: "feature", feature: "recurring_invoices", requiredPlan: "pro" },
    });
    expect(await t.run((ctx) => ctx.db.query("recurringInvoices").collect())).toHaveLength(0);
  });

  test("after a downgrade, existing templates stay readable and can be paused, but not edited or resumed", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id, clientId } = await newTemplate(owner);
    await t.run(async (ctx) => {
      const sub = await ctx.db.query("subscriptions").first();
      await ctx.db.patch("subscriptions", sub!._id, { status: "ended" });
    });

    expect((await owner.query(api.recurring.list, { paginationOpts: page(10) })).page).toHaveLength(1);
    expect((await owner.query(api.recurring.get, { id })).template._id).toBe(id);
    await owner.mutation(api.recurring.pause, { id });
    const refused = { data: { code: "UPGRADE_REQUIRED", feature: "recurring_invoices" } };
    await expect(owner.mutation(api.recurring.update, { id, ...(tpl(clientId) as object) } as never)).rejects.toMatchObject(refused);
    await expect(owner.mutation(api.recurring.resume, { id })).rejects.toMatchObject(refused);
  });

  test("a viewer can read templates but not change them", async () => {
    const { t, owner, viewer } = setup();
    await subscribe(t, "org_A", "pro");
    const { id, clientId } = await newTemplate(owner);
    expect((await viewer.query(api.recurring.get, { id })).template._id).toBe(id);
    const forbidden = { data: { code: "FORBIDDEN", capability: "invoices.write" } };
    await expect(viewer.mutation(api.recurring.create, tpl(clientId))).rejects.toMatchObject(forbidden);
    await expect(viewer.mutation(api.recurring.pause, { id })).rejects.toMatchObject(forbidden);
    await expect(viewer.mutation(api.recurring.remove, { id })).rejects.toMatchObject(forbidden);
  });

  test("every function needs a signed-in caller", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id } = await newTemplate(owner);
    const no = { data: { code: "UNAUTHENTICATED" } };
    await expect(t.query(api.recurring.list, { paginationOpts: page(10) })).rejects.toMatchObject(no);
    await expect(t.mutation(api.recurring.pause, { id })).rejects.toMatchObject(no);
  });
});

describe("create", () => {
  test("stores the template and its lines; the schedule starts at the start date", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const start = today() + 10 * DAY;
    const { id, clientId } = await newTemplate(owner, {
      startDate: start,
      frequency: "weekly",
      paymentTermsDays: 14,
      discountCents: 500,
      notes: "  Retainer  ",
      lineItems: [line({ description: "A" }), line({ description: "B", unitPriceCents: 1_000 })],
    });
    expect(await row(t, id)).toMatchObject({
      scopeId: "org_A",
      clientId,
      frequency: "weekly",
      startDate: start,
      nextRunAt: start,
      isActive: true,
      currency: "USD",
      paymentTermsDays: 14,
      discountCents: 500,
      notes: "Retainer",
    });
    const lines = await t.run((ctx) => ctx.db.query("recurringLineItems").collect());
    expect(lines.map((l) => [l.position, l.description])).toEqual([[0, "A"], [1, "B"]]);
  });

  test("payment terms default to the scope's setting", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    await t.run((ctx) =>
      ctx.db.insert("scopeSettings", {
        scopeId: "org_A", scopeKind: "org", currency: "USD", defaultTaxRatePct: 0,
        invoiceNumberPrefix: "INV-", nextInvoiceSeq: 1, paymentTermsDays: 45,
      }),
    );
    const { id } = await newTemplate(owner);
    expect((await row(t, id))?.paymentTermsDays).toBe(45);
  });

  test("a start date in the past does not backfill: the first run is the next scheduled date", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const start = today() - 100 * DAY;
    const { id } = await newTemplate(owner, { startDate: start, frequency: "monthly" });
    const { nextRunAt } = (await row(t, id))!;
    expect(nextRunAt).toBeGreaterThanOrEqual(today());
    expect(nextRunAt).toBeLessThan(today() + 32 * DAY);
    expect(nextRunAt).toBe(occurrenceAfter(start, "monthly", today() - 1));
  });

  test("the request cannot set the schedule state or the currency", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const clientId = await newClient(owner);
    for (const extra of [{ isActive: false }, { nextRunAt: 1 }, { currency: "EUR" }, { scopeId: "org_B" }, { lastError: "x" }]) {
      await expect(owner.mutation(api.recurring.create, tpl(clientId, extra))).rejects.toThrow();
    }
  });

  test("rejects bad input with a typed error naming the field", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const clientId = await newClient(owner);
    const bad = (over: Record<string, unknown>) =>
      owner.mutation(api.recurring.create, tpl(clientId, over)).catch((e) => e.data);
    expect(await bad({ lineItems: [] })).toMatchObject({ code: "INVALID_INPUT", field: "lineItems" });
    expect(await bad({ endDate: today() - 5 * DAY, startDate: today() })).toMatchObject({ field: "endDate" });
    expect(await bad({ paymentTermsDays: 400 })).toMatchObject({ field: "paymentTermsDays" });
    expect(await bad({ paymentTermsDays: 10.5 })).toMatchObject({ field: "paymentTermsDays" });
    expect(await bad({ discountCents: 999_999_999 })).toMatchObject({ field: "discountCents" });
    expect(await bad({ startDate: Number.NaN })).toMatchObject({ field: "startDate" });
  });

  test("only base-currency clients; archived and foreign clients are refused", async () => {
    const { t, owner, bob } = setup();
    await subscribe(t, "org_A", "business");
    const eur = await owner.mutation(api.clients.create, { name: "Euro Co", currency: "EUR" });
    await expect(owner.mutation(api.recurring.create, tpl(eur))).rejects.toMatchObject({
      data: { code: "INVALID_INPUT", field: "clientId" },
    });

    const archived = await newClient(owner, "Old");
    await owner.mutation(api.clients.archive, { id: archived });
    await expect(owner.mutation(api.recurring.create, tpl(archived))).rejects.toMatchObject({
      data: { code: "CONFLICT", reason: "client_archived" },
    });

    const bobs = await newClient(bob, "Bob Co");
    await expect(owner.mutation(api.recurring.create, tpl(bobs))).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
  });
});

describe("list, get, update, pause, resume, remove", () => {
  test("list and get show the client, lines and history fields", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id } = await newTemplate(owner, { lineItems: [line({ description: "Retainer" })] });
    const listed = (await owner.query(api.recurring.list, { paginationOpts: page(10) })).page;
    expect(listed).toMatchObject([{ _id: id, clientName: "Acme" }]);
    const got = await owner.query(api.recurring.get, { id });
    expect(got.lineItems.map((l) => l.description)).toEqual(["Retainer"]);
    expect(got.client).toMatchObject({ name: "Acme" });
  });

  test("templates are per scope", async () => {
    const { t, owner, bob } = setup();
    await subscribe(t, "org_A", "pro");
    await subscribe(t, "org_B", "pro");
    const { id } = await newTemplate(owner);
    await newTemplate(bob);
    expect((await owner.query(api.recurring.list, { paginationOpts: page(10) })).page).toHaveLength(1);
    await expect(bob.query(api.recurring.get, { id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(bob.mutation(api.recurring.pause, { id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(bob.mutation(api.recurring.remove, { id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  test("update replaces the lines and clears a recorded problem", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id, clientId } = await newTemplate(owner);
    await t.run((ctx) => ctx.db.patch("recurringInvoices", id, { lastError: "plan_required" }));
    await owner.mutation(api.recurring.update, {
      id,
      ...(tpl(clientId, { lineItems: [line({ description: "New", unitPriceCents: 7_000 })], frequency: "weekly" }) as object),
    } as never);
    const updated = await row(t, id);
    expect(updated).toMatchObject({ frequency: "weekly" });
    expect(updated?.lastError).toBeUndefined();
    const lines = await t.run((ctx) => ctx.db.query("recurringLineItems").collect());
    expect(lines).toMatchObject([{ description: "New", unitPriceCents: 7_000 }]);
  });

  test("pause stops it; resume restarts at the next scheduled date without catching up", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const start = today() - 100 * DAY;
    const { id } = await newTemplate(owner, { startDate: start });
    await owner.mutation(api.recurring.pause, { id });
    expect((await row(t, id))?.isActive).toBe(false);

    await t.run((ctx) => ctx.db.patch("recurringInvoices", id, { nextRunAt: start, lastError: "quota_reached" }));
    await owner.mutation(api.recurring.resume, { id });
    const after = await row(t, id);
    expect(after).toMatchObject({ isActive: true });
    expect(after?.lastError).toBeUndefined();
    expect(after!.nextRunAt).toBeGreaterThanOrEqual(today());
    expect(after!.nextRunAt).toBe(occurrenceAfter(start, "monthly", today() - 1));
  });

  test("a finished schedule cannot be resumed", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id } = await newTemplate(owner, { startDate: today() - 60 * DAY, endDate: today() - 30 * DAY });
    await expect(owner.mutation(api.recurring.resume, { id })).rejects.toMatchObject({
      data: { code: "CONFLICT", reason: "schedule_finished" },
    });
  });

  test("remove deletes the template and its lines but keeps invoices it made", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id } = await newTemplate(owner);
    await run(t);
    expect(await invoices(t)).toHaveLength(1);
    await owner.mutation(api.recurring.remove, { id });
    expect(await row(t, id)).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("recurringLineItems").collect())).toHaveLength(0);
    expect(await invoices(t)).toHaveLength(1);
  });
});

describe("generating", () => {
  test("makes one draft invoice, dated today, from the template", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id, clientId } = await newTemplate(owner, {
      paymentTermsDays: 14,
      discountCents: 1_000,
      notes: "Monthly retainer",
      lineItems: [line({ description: "Retainer", unitPriceCents: 25_000, taxRatePct: 10 }), line({ description: "Hosting", unitPriceCents: 5_000 })],
    });
    await run(t);

    const [inv] = await invoices(t);
    expect(inv).toMatchObject({
      scopeId: "org_A",
      clientId,
      status: "draft",
      invoiceNumber: "INV-0001",
      issueDate: today(),
      dueDate: today() + 14 * DAY,
      currency: "USD",
      subtotalCents: 30_000,
      taxCents: 2_500,
      discountCents: 1_000,
      totalCents: 31_500,
      paidCents: 0,
      notes: "Monthly retainer",
      recurringTemplateId: id,
    });
    expect(inv.publicToken).toBeUndefined(); // a draft is not shared
    const lines = await t.run((ctx) => ctx.db.query("invoiceLineItems").collect());
    expect(lines.map((l) => [l.position, l.description, l.amountCents])).toEqual([[0, "Retainer", 25_000], [1, "Hosting", 5_000]]);
  });

  test("advances the schedule and records the run", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id } = await newTemplate(owner);
    await run(t);
    const after = await row(t, id);
    expect(after!.nextRunAt).toBe(occurrence(today(), "monthly", 1));
    expect(after!.lastRunAt).toBeGreaterThan(0);
    expect(after!.lastInvoiceId).toBe((await invoices(t))[0]._id);
    expect(after!.lastError).toBeUndefined();
    expect(after!.isActive).toBe(true);
  });

  test("never more than one invoice per template per run, and a second run the same day does nothing", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    await newTemplate(owner);
    await run(t);
    await run(t);
    await run(t);
    expect(await invoices(t)).toHaveLength(1);
  });

  test("after downtime it makes ONE invoice and skips the missed runs instead of backfilling", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const start = today() - 150 * DAY;
    const { id } = await newTemplate(owner, { startDate: start, frequency: "weekly" });
    // As if the job had not run for five months.
    await t.run((ctx) => ctx.db.patch("recurringInvoices", id, { nextRunAt: start }));

    await run(t);
    expect(await invoices(t)).toHaveLength(1);
    const next = (await row(t, id))!.nextRunAt;
    expect(next).toBeGreaterThan(Date.now());
    expect(next - Date.now()).toBeLessThanOrEqual(7 * DAY_MS);
    expect((next - start) % (7 * DAY_MS)).toBe(0); // still on the original weekly rhythm
  });

  test("does not touch templates that are paused or not yet due", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const paused = await newTemplate(owner);
    await owner.mutation(api.recurring.pause, { id: paused.id });
    await newTemplate(owner, { startDate: today() + 5 * DAY });
    await run(t);
    expect(await invoices(t)).toHaveLength(0);
  });

  test("the last run of a schedule finishes the template", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id } = await newTemplate(owner, { endDate: today() + 10 * DAY });
    await run(t);
    expect(await invoices(t)).toHaveLength(1);
    const finished = await row(t, id);
    expect(finished?.isActive).toBe(false);
    expect(finished?.lastError).toBeUndefined();
  });

  test("a schedule already past its end date stops without making an invoice", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id } = await newTemplate(owner, { startDate: today() - 40 * DAY, endDate: today() - 10 * DAY });
    await t.run((ctx) => ctx.db.patch("recurringInvoices", id, { nextRunAt: today() - DAY }));
    await run(t);
    expect(await invoices(t)).toHaveLength(0);
    expect((await row(t, id))?.isActive).toBe(false);
  });

  test("the draft can be reviewed and sent like any other invoice", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    await newTemplate(owner);
    await run(t);
    const [inv] = await invoices(t);
    const { publicToken } = await owner.mutation(api.invoices.send, { id: inv._id });
    expect(publicToken).toHaveLength(43);
    expect((await owner.query(api.invoices.get, { id: inv._id })).invoice.status).toBe("sent");
  });

  test("counts toward the monthly invoice usage and is audited under the system actor", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    await newTemplate(owner);
    await run(t);
    const usage = await owner.query(api.usage.getUsageSummary, { now: Date.now() });
    expect(usage.invoices.used).toBe(1);
    const [inv] = await invoices(t);
    const log = await owner.query(api.audit.listAuditLog, {
      paginationOpts: page(20),
      entity: { table: "invoices", id: inv._id },
    });
    expect(log.page).toMatchObject([{ action: "create", actorUserId: "system", actorRole: "owner" }]);
  });

  test("numbers are per scope and continue the scope's own sequence", async () => {
    const { t, owner, bob } = setup();
    await subscribe(t, "org_A", "pro");
    await subscribe(t, "org_B", "pro");
    await newTemplate(owner);
    await newTemplate(owner, { clientId: await newClient(owner, "Second") });
    await newTemplate(bob);
    await run(t);
    const byScope = (await invoices(t)).reduce<Record<string, string[]>>((acc, i) => {
      (acc[i.scopeId] ??= []).push(i.invoiceNumber);
      return acc;
    }, {});
    expect(byScope.org_A.sort()).toEqual(["INV-0001", "INV-0002"]);
    expect(byScope.org_B).toEqual(["INV-0001"]);
  });

  test("works for a personal workspace too", async () => {
    const { t, personal } = setup();
    await subscribe(t, "user_alice", "pro", "active", "user");
    await newTemplate(personal);
    await run(t);
    expect((await invoices(t))[0]).toMatchObject({ scopeId: "user_alice", scopeKind: "user" });
  });
});

describe("when it cannot generate", () => {
  test("a lapsed plan defers to tomorrow with the reason, and resumes when the plan is back", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id } = await newTemplate(owner);
    const sub = await t.run((ctx) => ctx.db.query("subscriptions").first());
    await t.run((ctx) => ctx.db.patch("subscriptions", sub!._id, { status: "past_due" }));

    await run(t);
    expect(await invoices(t)).toHaveLength(0);
    expect(await row(t, id)).toMatchObject({ isActive: true, lastError: "plan_required", nextRunAt: today() + DAY_MS });

    // The plan is restored and the retry day arrives.
    await t.run((ctx) => ctx.db.patch("subscriptions", sub!._id, { status: "active" }));
    await t.run((ctx) => ctx.db.patch("recurringInvoices", id, { nextRunAt: today() }));
    await run(t);
    expect(await invoices(t)).toHaveLength(1);
    expect((await row(t, id))?.lastError).toBeUndefined();
  });

  test("an archived client stops the template, with the reason", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id, clientId } = await newTemplate(owner);
    await owner.mutation(api.clients.archive, { id: clientId });
    await run(t);
    expect(await invoices(t)).toHaveLength(0);
    expect(await row(t, id)).toMatchObject({ isActive: false, lastError: "client_unavailable" });
  });

  test("a client whose currency is no longer the base stops the template", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id, clientId } = await newTemplate(owner);
    await t.run((ctx) => ctx.db.patch("clients", clientId, { currency: "EUR" }));
    await run(t);
    expect(await invoices(t)).toHaveLength(0);
    expect(await row(t, id)).toMatchObject({ isActive: false, lastError: "currency_changed" });
  });

  test("a template with no lines stops rather than making an empty invoice", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const { id } = await newTemplate(owner);
    await t.run(async (ctx) => {
      for (const l of await ctx.db.query("recurringLineItems").collect()) await ctx.db.delete("recurringLineItems", l._id);
    });
    await run(t);
    expect(await invoices(t)).toHaveLength(0);
    expect(await row(t, id)).toMatchObject({ isActive: false, lastError: "no_line_items" });
  });

  test("one tenant's problem does not stop another's invoices", async () => {
    const { t, owner, bob } = setup();
    await subscribe(t, "org_A", "pro");
    await subscribe(t, "org_B", "pro");
    const a = await newTemplate(owner);
    await newTemplate(bob);
    await owner.mutation(api.clients.archive, { id: a.clientId });
    await run(t);
    const made = await invoices(t);
    expect(made).toHaveLength(1);
    expect(made[0].scopeId).toBe("org_B");
  });
});

describe("batching", () => {
  test("keeps going in batches until every due template has run", async () => {
    vi.useFakeTimers();
    try {
      const { t } = setup();
      const clientId = await t.run((ctx) =>
        ctx.db.insert("clients", {
          scopeId: "org_A", scopeKind: "org", name: "Bulk", currency: "USD", isArchived: false,
          outstandingCents: 0, totalBilledCents: 0, totalPaidCents: 0,
        }),
      );
      await subscribe(t, "org_A", "pro");
      await t.run(async (ctx) => {
        for (let i = 0; i < 120; i++) {
          const id = await ctx.db.insert("recurringInvoices", {
            scopeId: "org_A", scopeKind: "org", clientId, frequency: "monthly",
            startDate: today() - 30 * DAY, nextRunAt: today() - DAY, isActive: true,
            currency: "USD", paymentTermsDays: 30, discountCents: 0,
          });
          await ctx.db.insert("recurringLineItems", {
            scopeId: "org_A", scopeKind: "org", recurringInvoiceId: id, position: 0,
            description: `Item ${i}`, quantity: 1, unitPriceCents: 100, taxRatePct: 0,
          });
        }
      });

      await run(t);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const made = await invoices(t);
      expect(made).toHaveLength(120);
      expect(new Set(made.map((i) => i.invoiceNumber)).size).toBe(120);
      const stillDue = await t.run((ctx) =>
        ctx.db.query("recurringInvoices").withIndex("by_isActive_and_nextRunAt", (q) => q.eq("isActive", true).lte("nextRunAt", Date.now())).collect(),
      );
      expect(stillDue).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("crons", () => {
  test("recurring generation runs at 02:00 UTC, before the 03:00 overdue job", () => {
    const generate = crons.crons["generate recurring invoices"];
    const overdue = crons.crons["mark overdue invoices"];
    expect(JSON.stringify(generate.schedule)).toContain("0 2 * * *");
    expect(JSON.stringify(overdue.schedule)).toContain("0 3 * * *");
  });
});
