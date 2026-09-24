import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { getAll } from "convex-helpers/server/relationships";
import { internal } from "./_generated/api";
import { internalQuery } from "./_generated/server";
import { baseCurrency, requireCurrencyAllowed } from "./lib/currency";
import { invalidInput } from "./lib/errors";
import { normalizeExpenseInput, vExpenseInput } from "./lib/expenseInput";
import { getInScope, scopedMutation, scopedQuery } from "./lib/functions";
import { receiptProblem } from "./lib/receipts";
import { requireCapability } from "./lib/scope";

/**
 * Expenses and their receipts. Business logic only: scoping, row-level
 * security and the audit trail come from the scoped builders and triggers.
 *
 * Receipts live in Convex file storage. A stored file is not scoped to an
 * organization, so scoping is enforced on the expense row that points at it:
 * a file can be attached only if no expense anywhere has claimed it, and its
 * download URL is only ever minted after the expense passed `getInScope`.
 */

// --- Reads -----------------------------------------------------------------

/**
 * A page of expenses, newest first, with category and client names resolved.
 * Narrow by category and/or client, and by an inclusive date range (UTC ms).
 */
export const list = scopedQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    categoryId: v.optional(v.id("expenseCategories")),
    clientId: v.optional(v.id("clients")),
    from: v.optional(v.number()),
    to: v.optional(v.number()),
  },
  handler: async (ctx, { paginationOpts, categoryId, clientId, from, to }) => {
    requireCapability(ctx.scope, "expenses.read");
    const { scopeId } = ctx.scope;

    let result;
    if (categoryId !== undefined) {
      const rows = ctx.db
        .query("expenses")
        .withIndex("by_scopeId_and_categoryId_and_spentAt", (q) => {
          const base = q.eq("scopeId", scopeId).eq("categoryId", categoryId);
          if (from !== undefined && to !== undefined) return base.gte("spentAt", from).lte("spentAt", to);
          if (from !== undefined) return base.gte("spentAt", from);
          if (to !== undefined) return base.lte("spentAt", to);
          return base;
        })
        .order("desc");
      result = await (clientId === undefined
        ? rows
        : rows.filter((q) => q.eq(q.field("clientId"), clientId))
      ).paginate(paginationOpts);
    } else if (clientId !== undefined) {
      const rows = ctx.db
        .query("expenses")
        .withIndex("by_scopeId_and_clientId", (q) => q.eq("scopeId", scopeId).eq("clientId", clientId))
        .order("desc");
      result = await (from === undefined && to === undefined
        ? rows
        : rows.filter((q) =>
            q.and(
              q.gte(q.field("spentAt"), from ?? 0),
              q.lte(q.field("spentAt"), to ?? Number.MAX_SAFE_INTEGER),
            ),
          )
      ).paginate(paginationOpts);
    } else {
      result = await ctx.db
        .query("expenses")
        .withIndex("by_scopeId_and_spentAt", (q) => {
          const base = q.eq("scopeId", scopeId);
          if (from !== undefined && to !== undefined) return base.gte("spentAt", from).lte("spentAt", to);
          if (from !== undefined) return base.gte("spentAt", from);
          if (to !== undefined) return base.lte("spentAt", to);
          return base;
        })
        .order("desc")
        .paginate(paginationOpts);
    }

    const [categories, clients] = await Promise.all([
      getAll(ctx.db, "expenseCategories", result.page.map((e) => e.categoryId)),
      getAll(
        ctx.db,
        "clients",
        result.page.flatMap((e) => (e.clientId ? [e.clientId] : [])),
      ),
    ]);
    const clientNames = new Map(clients.flatMap((c) => (c ? [[c._id, c.name] as const] : [])));

    return {
      ...result,
      page: result.page.map((expense, i) => {
        // Rows say whether there is a receipt; the URL is minted only by `get`.
        const { receiptStorageId, ...row } = expense;
        return {
          ...row,
          hasReceipt: receiptStorageId !== undefined,
          categoryName: categories[i]?.name ?? null,
          clientName: expense.clientId ? (clientNames.get(expense.clientId) ?? null) : null,
        };
      }),
    };
  },
});

/** One expense with its category, client and a short-lived receipt URL. */
export const get = scopedQuery({
  args: { id: v.id("expenses") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "expenses.read");
    const expense = await getInScope(ctx, "expenses", id);

    const [category, client] = await Promise.all([
      ctx.db.get("expenseCategories", expense.categoryId),
      expense.clientId ? ctx.db.get("clients", expense.clientId) : null,
    ]);

    // The URL is only minted here, after the expense passed getInScope.
    // getUrl returns null if the file is gone, which is handled, not assumed.
    const receiptUrl = expense.receiptStorageId
      ? await ctx.storage.getUrl(expense.receiptStorageId)
      : null;

    return {
      expense,
      category: category && { _id: category._id, name: category.name },
      client: client && { _id: client._id, name: client.name },
      receiptUrl,
    };
  },
});

// --- Writes ----------------------------------------------------------------

export const create = scopedMutation({
  args: vExpenseInput,
  handler: async (ctx, args) => {
    requireCapability(ctx.scope, "expenses.write");
    const input = normalizeExpenseInput(args, Date.now());

    await getInScope(ctx, "expenseCategories", args.categoryId);
    if (args.clientId) await getInScope(ctx, "clients", args.clientId);

    const currency = input.currency ?? (await baseCurrency(ctx));
    await requireCurrencyAllowed(ctx, currency);

    return await ctx.db.insert("expenses", {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      categoryId: args.categoryId,
      vendor: input.vendor,
      description: input.description,
      amountCents: input.amountCents,
      taxCents: input.taxCents,
      currency,
      spentAt: input.spentAt,
      paymentMethod: input.paymentMethod,
      isBillable: input.isBillable,
      clientId: args.clientId,
      ocrStatus: "none",
    });
  },
});

/**
 * Replaces an expense's editable fields; omitted optional ones are cleared, so
 * send the whole form. The receipt has its own functions and is never touched.
 */
export const update = scopedMutation({
  args: { id: v.id("expenses"), ...vExpenseInput },
  handler: async (ctx, { id, ...args }) => {
    requireCapability(ctx.scope, "expenses.write");
    const expense = await getInScope(ctx, "expenses", id);
    const input = normalizeExpenseInput(args, Date.now());

    await getInScope(ctx, "expenseCategories", args.categoryId);
    if (args.clientId) await getInScope(ctx, "clients", args.clientId);

    const currency = input.currency ?? expense.currency;
    if (currency !== expense.currency) await requireCurrencyAllowed(ctx, currency);

    // Every key is named so an omitted optional field is cleared.
    await ctx.db.patch("expenses", id, {
      categoryId: args.categoryId,
      vendor: input.vendor,
      description: input.description,
      amountCents: input.amountCents,
      taxCents: input.taxCents,
      currency,
      spentAt: input.spentAt,
      paymentMethod: input.paymentMethod,
      isBillable: input.isBillable,
      clientId: args.clientId,
    });
  },
});

/** Deletes an expense and its receipt file. */
export const remove = scopedMutation({
  args: { id: v.id("expenses") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "expenses.write");
    const expense = await getInScope(ctx, "expenses", id);
    await ctx.db.delete("expenses", id);
    if (expense.receiptStorageId) await ctx.storage.delete(expense.receiptStorageId);
  },
});

// --- Receipts --------------------------------------------------------------

/**
 * A short-lived URL to upload one receipt file to. After the upload, pass the
 * returned storage id to `attachReceipt`.
 */
export const generateReceiptUploadUrl = scopedMutation({
  args: {},
  handler: async (ctx) => {
    requireCapability(ctx.scope, "expenses.write");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Whether any expense, in any organization, already holds this stored file.
 * Internal: it reads the one unscoped index that scoped code cannot reach.
 */
export const isReceiptClaimed = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }): Promise<boolean> => {
    const holder = await ctx.db
      .query("expenses")
      .withIndex("by_receiptStorageId", (q) => q.eq("receiptStorageId", storageId))
      .first();
    return holder !== null;
  },
});

/**
 * Attaches an uploaded file to an expense as its receipt, replacing any
 * earlier one. A file that is not an accepted type or is too large is deleted
 * and reported in the result (not thrown, since a thrown error would roll the
 * deletion back). A file another expense already holds is refused without
 * being touched, and is indistinguishable from one that does not exist.
 */
/** A receipt change invalidates anything scanned from the old file. */
const CLEARED_OCR = {
  ocrStatus: "none",
  ocrRaw: undefined,
  ocrSuggestion: undefined,
  ocrError: undefined,
  ocrStartedAt: undefined,
} as const;

export const attachReceipt = scopedMutation({
  args: { id: v.id("expenses"), storageId: v.id("_storage") },
  handler: async (ctx, { id, storageId }) => {
    requireCapability(ctx.scope, "expenses.write");
    const expense = await getInScope(ctx, "expenses", id);
    if (expense.receiptStorageId === storageId) return { ok: true as const };

    const unavailable = invalidInput("receipt", "That file is not available. Upload it again.");
    const meta = await ctx.db.system.get("_storage", storageId);
    if (meta === null) throw unavailable;
    const claimed: boolean = await ctx.runQuery(internal.expenses.isReceiptClaimed, { storageId });
    if (claimed) throw unavailable;

    const problem = receiptProblem(meta);
    if (problem !== null) {
      await ctx.storage.delete(storageId);
      return { ok: false as const, reason: problem };
    }

    // A different file invalidates anything scanned from the old one.
    await ctx.db.patch("expenses", id, {
      receiptStorageId: storageId,
      ...CLEARED_OCR,
    });
    if (expense.receiptStorageId) await ctx.storage.delete(expense.receiptStorageId);
    return { ok: true as const };
  },
});

/** Removes an expense's receipt and deletes the file. */
export const detachReceipt = scopedMutation({
  args: { id: v.id("expenses") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "expenses.write");
    const expense = await getInScope(ctx, "expenses", id);
    if (!expense.receiptStorageId) return;
    await ctx.db.patch("expenses", id, {
      receiptStorageId: undefined,
      ...CLEARED_OCR,
    });
    await ctx.storage.delete(expense.receiptStorageId);
  },
});
