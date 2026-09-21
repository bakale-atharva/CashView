import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { conflict } from "./lib/errors";
import { MAX_CATEGORIES, normalizeCategoryName } from "./lib/expenseInput";
import { getInScope, scopedMutation, scopedQuery } from "./lib/functions";
import { requireCapability } from "./lib/scope";
import { ensureScopeDefaults } from "./lib/scopeDefaults";
import type { Scope } from "./lib/validators";

/**
 * A scope's expense categories. Each scope gets the 14 starters when it is
 * created, then manages its own. Names are unique per scope, ignoring case.
 */

type Ctx = { db: DatabaseReader; scope: Scope };

async function allCategories(ctx: Ctx) {
  return await ctx.db
    .query("expenseCategories")
    .withIndex("by_scopeId_and_name", (q) => q.eq("scopeId", ctx.scope.scopeId))
    .take(MAX_CATEGORIES + 1);
}

/** Every category, alphabetical. Bounded: a scope may hold at most 100. */
export const list = scopedQuery({
  args: {},
  handler: async (ctx) => {
    requireCapability(ctx.scope, "expenses.read");
    const rows = await allCategories(ctx);
    return rows
      .slice(0, MAX_CATEGORIES)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  },
});

/**
 * Gives a scope its starter categories if it has none (an organization that
 * existed before the sync was connected, say). Safe to call any number of times.
 */
export const ensureDefaults = scopedMutation({
  args: {},
  handler: async (ctx) => {
    requireCapability(ctx.scope, "expenses.write");
    await ensureScopeDefaults(ctx, {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
    });
  },
});

export const create = scopedMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    requireCapability(ctx.scope, "expenses.write");
    const clean = normalizeCategoryName(name);

    const existing = await allCategories(ctx);
    if (existing.length >= MAX_CATEGORIES) throw conflict("too_many_categories");
    if (existing.some((c) => c.name.toLowerCase() === clean.toLowerCase())) {
      throw conflict("category_exists");
    }
    return await ctx.db.insert("expenseCategories", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      name: clean,
      isDefault: false,
    });
  },
});

export const rename = scopedMutation({
  args: { id: v.id("expenseCategories"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    requireCapability(ctx.scope, "expenses.write");
    await getInScope(ctx, "expenseCategories", id);
    const clean = normalizeCategoryName(name);

    const others = (await allCategories(ctx)).filter((c) => c._id !== id);
    if (others.some((c) => c.name.toLowerCase() === clean.toLowerCase())) {
      throw conflict("category_exists");
    }
    await ctx.db.patch("expenseCategories", id, { name: clean });
  },
});

/**
 * Deletes a category nothing uses. One with expenses cannot be deleted, since
 * they would be left uncategorised; move them to another category first.
 */
export const remove = scopedMutation({
  args: { id: v.id("expenseCategories") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "expenses.write");
    await getInScope(ctx, "expenseCategories", id);

    const inUse = await ctx.db
      .query("expenses")
      .withIndex("by_scopeId_and_categoryId_and_spentAt", (q) =>
        q.eq("scopeId", ctx.scope.scopeId).eq("categoryId", id as Id<"expenseCategories">),
      )
      .first();
    if (inUse !== null) throw conflict("category_in_use");

    await ctx.db.delete("expenseCategories", id);
  },
});
