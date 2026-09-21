import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { getInScope, internalScopedMutation } from "./lib/functions";
import { startOfUtcDay } from "./lib/invoiceMath";
import { assertTransition, isPastDue } from "./lib/invoiceStatus";

/**
 * Marks open invoices overdue once their due day has passed. Run daily by
 * crons.ts; never called by a client.
 *
 * Each invoice is moved through the scoped writer under a "system" actor, so
 * the change is audited and goes through the same rules as any other write.
 */

const BATCH = 100;

export const markOverdue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = startOfUtcDay(Date.now());
    let changed = 0;
    let full = false;

    // Invoices already `overdue` or `paid` are not in these two statuses, so
    // each run only ever sees work that is still to do.
    for (const status of ["sent", "viewed"] as const) {
      const due = await ctx.db
        .query("invoices")
        .withIndex("by_status_and_dueDate", (q) =>
          q.eq("status", status).lt("dueDate", cutoff),
        )
        .take(BATCH);

      for (const invoice of due) {
        try {
          const moved = await ctx.runMutation(internal.invoicesCron.markOverdueOne, {
            scope: {
              scopeId: invoice.scopeId,
              scopeKind: invoice.scopeKind,
              userId: "system",
              role: "owner",
            },
            id: invoice._id,
          });
          if (moved) changed++;
        } catch (error) {
          // One bad row must not stop the rest.
          console.error(`Could not mark invoice ${invoice._id} overdue`, error);
        }
      }
      if (due.length === BATCH) full = true;
    }

    // More may be waiting. Only continue if this pass made progress, so a row
    // that keeps failing cannot reschedule this job forever.
    if (full && changed > 0) {
      await ctx.scheduler.runAfter(0, internal.invoicesCron.markOverdue, {});
    }
  },
});

export const markOverdueOne = internalScopedMutation({
  args: { id: v.id("invoices") },
  handler: async (ctx, { id }) => {
    const invoice = await getInScope(ctx, "invoices", id);
    // Re-checked here: the invoice may have been paid or voided since it was listed.
    if (
      (invoice.status !== "sent" && invoice.status !== "viewed") ||
      !isPastDue(invoice.dueDate, Date.now())
    ) {
      return false;
    }
    assertTransition(invoice.status, "overdue");
    await ctx.db.patch("invoices", id, { status: "overdue" });
    return true;
  },
});
