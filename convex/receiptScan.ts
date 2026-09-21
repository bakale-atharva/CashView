import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { env } from "./_generated/server";
import { requireCurrencyAllowed } from "./lib/currency";
import { requireFeature } from "./lib/entitlements";
import { conflict, invalidInput } from "./lib/errors";
import { MAX_CATEGORIES, normalizeExpenseInput } from "./lib/expenseInput";
import {
  getInScope,
  internalScopedMutation,
  scopedAction,
  scopedMutation,
} from "./lib/functions";
import {
  MAX_RAW_CHARS,
  OPENROUTER_URL,
  REQUEST_TIMEOUT_MS,
  SCAN_MODELS,
  STALE_SCAN_MS,
  buildRequestBody,
  extractContent,
  isScannable,
  parseScan,
  toBase64,
} from "./lib/receiptScan";
import { requireCapability } from "./lib/scope";
import { vOcrSuggestion } from "./lib/validators";

/**
 * AI receipt scanning (Business plan).
 *
 * A scan only ever *proposes*. The model's answer is validated field by field
 * (lib/receiptScan.ts) and stored as `ocrSuggestion`; nothing changes on the
 * expense until a person calls `applyScan`. The expense is never left stuck
 * "pending": every path out of `scan` records a result, and a scan that died
 * mid-way is retryable after two minutes.
 *
 * This is an action because it calls out to the network, and it needs no
 * `"use node"`: it uses only `fetch`, `btoa` and typed arrays, all available in
 * the default runtime, so it stays with the queries and mutations it calls.
 */

type ScanTarget = {
  storageId: Id<"_storage">;
  contentType: string;
  categories: { _id: Id<"expenseCategories">; name: string }[];
};

export type ScanResult = { ok: true; model: string } | { ok: false; reason: string };

// --- Internal steps (run inside the action) -----------------------------------

/**
 * Claims the scan: checks the plan and the receipt, marks the expense pending,
 * and hands back what the action needs. Refuses a second scan while one is
 * genuinely in flight.
 */
export const begin = internalScopedMutation({
  args: { id: v.id("expenses") },
  handler: async (ctx, { id }): Promise<ScanTarget> => {
    requireCapability(ctx.scope, "expenses.write");
    await requireFeature(ctx, "receipt_scanning");

    const expense = await getInScope(ctx, "expenses", id);
    if (!expense.receiptStorageId) {
      throw invalidInput("receipt", "Attach a receipt before scanning.");
    }

    const now = Date.now();
    if (
      expense.ocrStatus === "pending" &&
      expense.ocrStartedAt !== undefined &&
      now - expense.ocrStartedAt < STALE_SCAN_MS
    ) {
      throw conflict("scan_in_progress");
    }

    const meta = await ctx.db.system.get("_storage", expense.receiptStorageId);
    const categories = await ctx.db
      .query("expenseCategories")
      .withIndex("by_scopeId_and_name", (q) => q.eq("scopeId", ctx.scope.scopeId))
      .take(MAX_CATEGORIES);

    await ctx.db.patch("expenses", id, {
      ocrStatus: "pending",
      ocrStartedAt: now,
      ocrError: undefined,
      ocrSuggestion: undefined,
      ocrRaw: undefined,
    });
    return {
      storageId: expense.receiptStorageId,
      contentType: meta?.contentType ?? "",
      categories: categories.map((c) => ({ _id: c._id, name: c.name })),
    };
  },
});

/**
 * Records the outcome. Ignored (returns false) if the expense moved on while
 * the model was working: the receipt was replaced or removed, so the result
 * describes a file the expense no longer has.
 */
export const finish = internalScopedMutation({
  args: {
    id: v.id("expenses"),
    storageId: v.id("_storage"),
    suggestion: v.optional(vOcrSuggestion),
    raw: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, storageId, suggestion, raw, error }): Promise<boolean> => {
    const expense = await getInScope(ctx, "expenses", id);
    if (expense.receiptStorageId !== storageId || expense.ocrStatus !== "pending") return false;

    if (error !== undefined || suggestion === undefined) {
      await ctx.db.patch("expenses", id, {
        ocrStatus: "failed",
        ocrError: error ?? "Couldn't read this receipt.",
        ocrStartedAt: undefined,
      });
      return true;
    }

    // Belt and braces: a suggested category must be one of this scope's own.
    let categoryId = suggestion.categoryId;
    if (categoryId !== undefined) {
      const category = await ctx.db.get("expenseCategories", categoryId);
      if (category === null || category.scopeId !== ctx.scope.scopeId) categoryId = undefined;
    }

    await ctx.db.patch("expenses", id, {
      ocrStatus: "done",
      ocrSuggestion: { ...suggestion, categoryId },
      ocrRaw: raw?.slice(0, MAX_RAW_CHARS),
      ocrError: undefined,
      ocrStartedAt: undefined,
    });
    return true;
  },
});

// --- Public ----------------------------------------------------------------------

/**
 * Scans an expense's receipt. Resolves with the outcome rather than throwing
 * for anything about the scan itself (unreadable, service down, wrong file
 * type), so a form can show the reason; plan, permission and "already
 * scanning" problems are thrown as usual.
 */
export const scan = scopedAction({
  args: { id: v.id("expenses") },
  handler: async (ctx, { id }): Promise<ScanResult> => {
    const target: ScanTarget = await ctx.runMutation(internal.receiptScan.begin, {
      scope: ctx.scope,
      id,
    });

    const finish = (outcome: {
      suggestion?: typeof vOcrSuggestion.type;
      raw?: string;
      error?: string;
    }): Promise<boolean> =>
      ctx.runMutation(internal.receiptScan.finish, {
        scope: ctx.scope,
        id,
        storageId: target.storageId,
        ...outcome,
      });
    const fail = async (reason: string): Promise<ScanResult> => {
      await finish({ error: reason });
      return { ok: false, reason };
    };

    try {
      if (!isScannable(target.contentType)) {
        return await fail("Only JPG, PNG and WebP receipts can be scanned. Enter this one yourself.");
      }
      const key = env.OPENROUTER_API_KEY;
      if (!key) return await fail("Receipt scanning isn't set up yet.");

      const blob = await ctx.storage.get(target.storageId);
      if (blob === null) return await fail("The receipt file could not be found.");
      const base64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
      const mimeType = target.contentType.toLowerCase().split(";")[0].trim();
      const categoryNames = target.categories.map((c) => c.name);

      let lastReason = "Couldn't read this receipt. Enter the details yourself.";
      for (const model of SCAN_MODELS) {
        let content: string | null;
        try {
          const response = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
              "X-Title": "CashView",
            },
            body: JSON.stringify(buildRequestBody(model, mimeType, base64, categoryNames)),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!response.ok) {
            lastReason = `The scanning service is unavailable right now (${response.status}).`;
            continue;
          }
          content = extractContent(await response.json());
        } catch {
          // Never log the request: it carries the key and the receipt image.
          lastReason = "The scanning service could not be reached.";
          continue;
        }
        if (content === null) continue;

        const parsed = parseScan(content, target.categories, Date.now());
        if (!parsed.ok) {
          lastReason = parsed.reason;
          continue;
        }
        const stored = await finish({
          suggestion: { ...parsed.suggestion, model },
          raw: content,
        });
        return stored
          ? { ok: true, model }
          : { ok: false, reason: "The receipt changed while it was being scanned." };
      }
      return await fail(lastReason);
    } catch (error) {
      console.error("Receipt scan failed:", error instanceof Error ? error.name : "unknown");
      return await fail("Something went wrong while scanning. Enter the details yourself.");
    }
  },
});

/**
 * Confirms the scan: copies the suggested fields onto the expense, through the
 * same validation as any edit, and clears the suggestion. Fields the scan did
 * not find are left as they are.
 */
export const applyScan = scopedMutation({
  args: { id: v.id("expenses") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "expenses.write");
    const expense = await getInScope(ctx, "expenses", id);
    const s = expense.ocrSuggestion;
    if (s === undefined) throw conflict("no_scan_suggestion");

    const amountCents = s.amountCents ?? expense.amountCents;
    const input = normalizeExpenseInput(
      {
        vendor: s.vendor ?? expense.vendor,
        description: expense.description,
        amountCents,
        // A new amount makes the old tax meaningless unless the scan found one.
        taxCents: s.taxCents ?? (s.amountCents !== undefined ? 0 : expense.taxCents),
        currency: s.currency ?? expense.currency,
        spentAt: s.spentAt ?? expense.spentAt,
        paymentMethod: expense.paymentMethod,
        isBillable: expense.isBillable,
        clientId: expense.clientId,
      },
      Date.now(),
    );

    const categoryId = s.categoryId ?? expense.categoryId;
    if (categoryId !== expense.categoryId) await getInScope(ctx, "expenseCategories", categoryId);
    const currency = input.currency ?? expense.currency;
    if (currency !== expense.currency) await requireCurrencyAllowed(ctx, currency);

    await ctx.db.patch("expenses", id, {
      categoryId,
      vendor: input.vendor,
      amountCents: input.amountCents,
      taxCents: input.taxCents,
      currency,
      spentAt: input.spentAt,
      ocrSuggestion: undefined,
    });
  },
});

/** Rejects the scan's suggestion and leaves the expense as it is. */
export const dismissScan = scopedMutation({
  args: { id: v.id("expenses") },
  handler: async (ctx, { id }) => {
    requireCapability(ctx.scope, "expenses.write");
    await getInScope(ctx, "expenses", id);
    await ctx.db.patch("expenses", id, { ocrSuggestion: undefined });
  },
});
