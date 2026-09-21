import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { baseCurrency } from "./lib/currency";
import { DAY_MS, startOfUtcDay } from "./lib/dates";
import { assertQuota, getEntitlements, hasFeature } from "./lib/entitlements";
import { getInScope, internalScopedMutation } from "./lib/functions";
import { allocateNumber, loadSettings, writeLines } from "./invoices";
import { MAX_LINES, computeTotals } from "./lib/invoiceMath";
import { occurrenceAfter } from "./lib/recurrence";

/**
 * Turns due recurring templates into draft invoices. Run daily by crons.ts;
 * never called by a client.
 *
 * Rules, each covered by a test:
 * - At most one invoice per template per run, dated today. After downtime it
 *   does not backfill the runs it missed; it resumes at the next scheduled
 *   date counted from the template's start date.
 * - It only ever creates a draft. A person reviews and sends it.
 * - The same rules as a person creating an invoice apply: the monthly invoice
 *   quota and the plan feature. When either refuses, the template is deferred
 *   to tomorrow with the reason recorded (`lastError`), so it generates as soon
 *   as the plan or quota allows and is never silently dropped.
 * - A template that can never run again (client archived or gone, currency
 *   changed, schedule finished) is stopped, with the reason recorded.
 * - Each invoice is created through the scoped writer under a "system" actor,
 *   so it is audited and counted like any other.
 */

const BATCH = 50;

export type GenerateOutcome = "generated" | "deferred" | "stopped" | "noop";

export const generateDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("recurringInvoices")
      .withIndex("by_isActive_and_nextRunAt", (q) => q.eq("isActive", true).lte("nextRunAt", now))
      .take(BATCH);

    let moved = 0;
    for (const template of due) {
      try {
        const outcome: GenerateOutcome = await ctx.runMutation(
          internal.recurringCron.generateOne,
          {
            scope: {
              scopeId: template.scopeId,
              scopeKind: template.scopeKind,
              userId: "system",
              role: "owner",
            },
            id: template._id,
          },
        );
        if (outcome !== "noop") moved++;
      } catch (error) {
        // One bad template must not stop the rest.
        console.error(`Could not run recurring template ${template._id}`, error);
      }
    }

    // Every outcome except "noop" takes the template out of the due set (it is
    // advanced, deferred to tomorrow, or stopped), so a full batch that made
    // progress has more waiting and one that did not is not retried forever.
    if (due.length === BATCH && moved > 0) {
      await ctx.scheduler.runAfter(0, internal.recurringCron.generateDue, {});
    }
  },
});

export const generateOne = internalScopedMutation({
  args: { id: v.id("recurringInvoices") },
  handler: async (ctx, { id }): Promise<GenerateOutcome> => {
    const template = await getInScope(ctx, "recurringInvoices", id);
    const now = Date.now();
    const today = startOfUtcDay(now);
    // Re-checked: it may have been paused, edited or run since it was listed.
    if (!template.isActive || template.nextRunAt > now) return "noop";

    const stop = async (reason: string | undefined): Promise<GenerateOutcome> => {
      await ctx.db.patch("recurringInvoices", id, {
        isActive: false,
        lastRunAt: now,
        lastError: reason,
      });
      return "stopped";
    };
    const defer = async (reason: string): Promise<GenerateOutcome> => {
      await ctx.db.patch("recurringInvoices", id, {
        nextRunAt: today + DAY_MS,
        lastRunAt: now,
        lastError: reason,
      });
      return "deferred";
    };

    if (template.endDate !== undefined && today > template.endDate) return await stop(undefined);

    if (!hasFeature(await getEntitlements(ctx), "recurring_invoices")) {
      return await defer("plan_required");
    }

    const client = await ctx.db.get("clients", template.clientId);
    if (client === null || client.isArchived) return await stop("client_unavailable");
    if (client.currency !== (await baseCurrency(ctx))) return await stop("currency_changed");

    const lines = await ctx.db
      .query("recurringLineItems")
      .withIndex("by_scopeId_and_recurringInvoiceId_and_position", (q) =>
        q.eq("scopeId", ctx.scope.scopeId).eq("recurringInvoiceId", id),
      )
      .take(MAX_LINES + 1);
    if (lines.length === 0) return await stop("no_line_items");

    let totals;
    try {
      totals = computeTotals(lines, template.discountCents);
    } catch {
      return await stop("invalid_template");
    }

    try {
      await assertQuota(ctx, "invoices", now);
    } catch (error) {
      const data = error instanceof ConvexError ? (error.data as { code?: string }) : undefined;
      if (data?.code === "UPGRADE_REQUIRED") return await defer("quota_reached");
      throw error;
    }

    const settings = await loadSettings(ctx);
    const invoiceId = await ctx.db.insert("invoices", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      clientId: client._id,
      invoiceNumber: await allocateNumber(ctx, settings),
      status: "draft",
      issueDate: today,
      dueDate: today + template.paymentTermsDays * DAY_MS,
      currency: client.currency,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      discountCents: totals.discountCents,
      totalCents: totals.totalCents,
      paidCents: 0,
      notes: template.notes,
      recurringTemplateId: template._id,
    });
    await writeLines(ctx, invoiceId, totals.lines);

    // The next run is counted from the start date, after now: any runs missed
    // during downtime are skipped, not made up.
    const nextRunAt = occurrenceAfter(template.startDate, template.frequency, now);
    const finished = template.endDate !== undefined && nextRunAt > template.endDate;
    await ctx.db.patch("recurringInvoices", id, {
      nextRunAt,
      isActive: !finished,
      lastRunAt: now,
      lastInvoiceId: invoiceId,
      lastError: undefined,
    });
    return "generated";
  },
});
