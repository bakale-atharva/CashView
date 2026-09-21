/// <reference types="vite/client" />
import { ConvexError } from "convex/values";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { DAY_MS, startOfUtcDay } from "./lib/dates";
import { line, newClient, setup, subscribe } from "./testkit.testutil";
import type { Ctx } from "./testkit.testutil";

// No paid plan has an invoice quota today (Free has one but no recurring
// invoices), so the generator's "quota reached" branch cannot be reached with
// real plan data. It exists so the day a plan combines the two, a full quota
// defers a template instead of failing it. This file tests that branch by
// forcing assertQuota to refuse, and is kept separate so the mock touches
// nothing else.
const control = vi.hoisted(() => ({ mode: "off" as "off" | "quota" | "boom", boomForScope: "" }));

vi.mock("./lib/entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/entitlements")>();
  return {
    ...actual,
    assertQuota: async (ctx: Parameters<typeof actual.assertQuota>[0], metric: "clients" | "invoices", now?: number) => {
      if (metric === "invoices" && control.mode === "quota") {
        throw new ConvexError({ code: "UPGRADE_REQUIRED", reason: "quota", metric });
      }
      if (metric === "invoices" && control.mode === "boom" && ctx.scope.scopeId === control.boomForScope) {
        throw new Error("unexpected failure");
      }
      return actual.assertQuota(ctx, metric, now);
    },
  };
});

afterEach(() => {
  control.mode = "off";
  control.boomForScope = "";
});

const today = () => startOfUtcDay(Date.now());
const run = (t: Ctx["t"]) => t.mutation(internal.recurringCron.generateDue, {});
const invoices = (t: Ctx["t"]) => t.run((ctx) => ctx.db.query("invoices").collect());

async function newTemplate(actor: Ctx["owner"]) {
  const clientId = await newClient(actor);
  return await actor.mutation(api.recurring.create, {
    clientId,
    frequency: "monthly",
    startDate: today(),
    lineItems: [line()],
  });
}

describe("when the invoice quota is full", () => {
  test("the template is deferred to tomorrow with the reason, and no number is used up", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const id = await newTemplate(owner);
    control.mode = "quota";

    await run(t);
    expect(await invoices(t)).toHaveLength(0);
    const template = await t.run((ctx) => ctx.db.get("recurringInvoices", id));
    expect(template).toMatchObject({ isActive: true, lastError: "quota_reached", nextRunAt: today() + DAY_MS });
    // The number sequence was not consumed by the refused attempt.
    const settings = await t.run((ctx) => ctx.db.query("scopeSettings").first());
    expect(settings?.nextInvoiceSeq ?? 1).toBe(1);
  });

  test("it generates as soon as there is room again", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    const id = await newTemplate(owner);
    control.mode = "quota";
    await run(t);

    control.mode = "off";
    await t.run((ctx) => ctx.db.patch("recurringInvoices", id, { nextRunAt: today() })); // the retry day
    await run(t);
    expect(await invoices(t)).toHaveLength(1);
    const template = await t.run((ctx) => ctx.db.get("recurringInvoices", id));
    expect(template?.lastError).toBeUndefined();
  });

  test("a deferred template leaves the due set, so it cannot starve the ones behind it", async () => {
    const { t, owner } = setup();
    await subscribe(t, "org_A", "pro");
    await newTemplate(owner);
    control.mode = "quota";
    await run(t);
    const stillDue = await t.run((ctx) =>
      ctx.db.query("recurringInvoices").withIndex("by_isActive_and_nextRunAt", (q) => q.eq("isActive", true).lte("nextRunAt", Date.now())).collect(),
    );
    expect(stillDue).toHaveLength(0);
  });
});

describe("an unexpected failure", () => {
  test("in one tenant's template is contained: the others still run, and the failed one is left as it was", async () => {
    const { t, owner, bob } = setup();
    await subscribe(t, "org_A", "pro");
    await subscribe(t, "org_B", "pro");
    const a = await newTemplate(owner);
    const b = await newTemplate(bob);
    control.mode = "boom";
    control.boomForScope = "org_A";

    await run(t);
    const made = await invoices(t);
    expect(made.map((i) => i.scopeId)).toEqual(["org_B"]);

    // The failed one was rolled back, not half-applied, and stays due for the next run.
    const failed = await t.run((ctx) => ctx.db.get("recurringInvoices", a));
    expect(failed).toMatchObject({ isActive: true });
    expect(failed?.lastInvoiceId).toBeUndefined();
    expect(failed!.nextRunAt).toBeLessThanOrEqual(Date.now());
    const ok = await t.run((ctx) => ctx.db.get("recurringInvoices", b));
    expect(ok!.nextRunAt).toBeGreaterThan(Date.now());
  });

  test("a failing template that keeps failing does not reschedule the job forever", async () => {
    vi.useFakeTimers();
    try {
      const { t, owner } = setup();
      await subscribe(t, "org_A", "pro");
      await newTemplate(owner);
      control.mode = "boom";
      control.boomForScope = "org_A";
      await run(t);
      // Nothing moved, so nothing is scheduled to run again.
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await invoices(t)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
