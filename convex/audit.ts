import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { scopedQuery } from "./lib/functions";
import { requireCapability } from "./lib/scope";

/**
 * The scope's audit trail, newest first. The rows are written by triggers
 * (lib/triggers.ts); nothing here or in any mutation writes them by hand.
 * Owners and admins only.
 *
 * Pass `entity` to see the history of one record.
 */
export const listAuditLog = scopedQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    entity: v.optional(v.object({ table: v.string(), id: v.string() })),
  },
  handler: async (ctx, { paginationOpts, entity }) => {
    requireCapability(ctx.scope, "audit.read");

    const rows = entity
      ? ctx.db
          .query("auditLogs")
          .withIndex("by_scopeId_and_entityTable_and_entityId", (q) =>
            q
              .eq("scopeId", ctx.scope.scopeId)
              .eq("entityTable", entity.table)
              .eq("entityId", entity.id),
          )
      : ctx.db
          .query("auditLogs")
          .withIndex("by_scopeId", (q) => q.eq("scopeId", ctx.scope.scopeId));

    return await rows.order("desc").paginate(paginationOpts);
  },
});
