import { v } from "convex/values";
import { internal } from "./_generated/api";
import { env, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { planKeyFromSlug } from "./lib/plans";
import { ensureScopeDefaults } from "./lib/scopeDefaults";
import { vScopeKind } from "./lib/validators";

/**
 * Clerk -> Convex sync. Each function is called by the webhook handler in
 * http.ts and is internal, so nothing here is reachable from a client.
 *
 * Webhooks are delivered at least once and may arrive out of order, so every
 * handler is an upsert or a tolerant delete: replaying an event changes
 * nothing.
 *
 * These use the raw db on purpose. They write global/synced tables and have
 * no acting user, so the audit/counter triggers (which need a scope and an
 * actor) do not apply.
 */

// --- Users -----------------------------------------------------------------

export const upsertUser = internalMutation({
  args: {
    clerkUserId: v.string(),
    email: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const issuer = env.CLERK_FRONTEND_API_URL;
    if (!issuer) {
      throw new Error("CLERK_FRONTEND_API_URL is not set in the Convex environment.");
    }
    // Named explicitly, not spread from args: Convex drops `undefined` args
    // before they reach the handler, and a patch only clears a field that is
    // present with the value `undefined`. Spreading would leave a removed
    // email or image behind.
    const fields = {
      clerkUserId: args.clerkUserId,
      // What identity.tokenIdentifier will be for this user's tokens.
      tokenIdentifier: `${issuer}|${args.clerkUserId}`,
      email: args.email,
      firstName: args.firstName,
      lastName: args.lastName,
      imageUrl: args.imageUrl,
    };
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", args.clerkUserId))
      .first();
    if (existing) {
      await ctx.db.patch("users", existing._id, fields);
    } else {
      await ctx.db.insert("users", fields);
    }

    // A personal scope is its own set of books.
    const name = [args.firstName, args.lastName].filter(Boolean).join(" ");
    await ensureScopeDefaults(ctx, {
      scopeId: args.clerkUserId,
      scopeKind: "user",
      businessName: name || undefined,
    });
  },
});

export const deleteUser = internalMutation({
  args: { clerkUserId: v.string() },
  handler: async (ctx, { clerkUserId }) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", clerkUserId))
      .first();
    if (existing) await ctx.db.delete("users", existing._id);
    // The user's personal books are kept: deleting accounting records because
    // an account went away is a product decision, not a sync side effect.
  },
});

// --- Organizations ---------------------------------------------------------

export const upsertOrganization = internalMutation({
  args: {
    clerkOrgId: v.string(),
    name: v.string(),
    slug: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", args.clerkOrgId))
      .first();
    // Explicit for the same reason as upsertUser: a removed slug or image
    // must be cleared, and `undefined` args never arrive to do it.
    const fields = {
      clerkOrgId: args.clerkOrgId,
      name: args.name,
      slug: args.slug,
      imageUrl: args.imageUrl,
    };
    if (existing) {
      await ctx.db.patch("organizations", existing._id, fields);
    } else {
      await ctx.db.insert("organizations", fields);
    }
    await ensureScopeDefaults(ctx, {
      scopeId: args.clerkOrgId,
      scopeKind: "org",
      businessName: args.name,
    });
  },
});

const PURGE_BATCH = 100;

async function purgeSyncedRows(ctx: MutationCtx, scopeId: string) {
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_scopeId_and_clerkUserId", (q) => q.eq("scopeId", scopeId))
    .take(PURGE_BATCH);
  for (const row of memberships) await ctx.db.delete("memberships", row._id);

  const subscriptions = await ctx.db
    .query("subscriptions")
    .withIndex("by_scopeId", (q) => q.eq("scopeId", scopeId))
    .take(PURGE_BATCH);
  for (const row of subscriptions) await ctx.db.delete("subscriptions", row._id);

  if (memberships.length === PURGE_BATCH || subscriptions.length === PURGE_BATCH) {
    await ctx.scheduler.runAfter(0, internal.sync.purgeOrganizationRows, { scopeId });
  }
}

export const purgeOrganizationRows = internalMutation({
  args: { scopeId: v.string() },
  handler: async (ctx, { scopeId }) => {
    await purgeSyncedRows(ctx, scopeId);
  },
});

export const deleteOrganization = internalMutation({
  args: { clerkOrgId: v.string() },
  handler: async (ctx, { clerkOrgId }) => {
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_clerkOrgId", (q) => q.eq("clerkOrgId", clerkOrgId))
      .first();
    if (existing) await ctx.db.delete("organizations", existing._id);
    // Only the synced rows go. The organization's books (clients, invoices,
    // expenses, ...) are retained for the same reason as a deleted user's.
    await purgeSyncedRows(ctx, clerkOrgId);
  },
});

// --- Memberships -----------------------------------------------------------

async function findMembership(
  ctx: MutationCtx,
  clerkOrgId: string,
  clerkUserId: string,
) {
  return await ctx.db
    .query("memberships")
    .withIndex("by_scopeId_and_clerkUserId", (q) =>
      q.eq("scopeId", clerkOrgId).eq("clerkUserId", clerkUserId),
    )
    .first();
}

export const upsertMembership = internalMutation({
  args: {
    clerkOrgId: v.string(),
    clerkUserId: v.string(),
    role: v.string(), // raw Clerk key, e.g. "org:owner"
    joinedAt: v.number(),
  },
  handler: async (ctx, { clerkOrgId, clerkUserId, role, joinedAt }) => {
    const existing = await findMembership(ctx, clerkOrgId, clerkUserId);
    if (existing) {
      // joinedAt is when they joined, not when the role last changed.
      await ctx.db.patch("memberships", existing._id, { role });
    } else {
      await ctx.db.insert("memberships", {
        scopeId: clerkOrgId,
        clerkUserId,
        role,
        joinedAt,
      });
    }
  },
});

export const deleteMembership = internalMutation({
  args: { clerkOrgId: v.string(), clerkUserId: v.string() },
  handler: async (ctx, { clerkOrgId, clerkUserId }) => {
    const existing = await findMembership(ctx, clerkOrgId, clerkUserId);
    if (existing) await ctx.db.delete("memberships", existing._id);
  },
});

// --- Subscriptions ---------------------------------------------------------

const vItem = v.object({
  scopeId: v.string(),
  scopeKind: vScopeKind,
  clerkSubscriptionId: v.optional(v.string()),
  clerkSubscriptionItemId: v.string(),
  planSlug: v.optional(v.string()),
  features: v.array(v.string()),
  status: v.string(),
  currentPeriodStart: v.optional(v.number()),
  currentPeriodEnd: v.optional(v.number()),
});

/**
 * One row per subscription item (a payer's hold on one plan). Applies both
 * `subscription.*` events (all items at once) and `subscriptionItem.*` events
 * (the item alone). The row is found by item id; failing that, by plan slug
 * for an item id we hadn't recorded yet.
 */
export const upsertSubscriptionItems = internalMutation({
  args: { items: v.array(vItem) },
  handler: async (ctx, { items }) => {
    for (const item of items) {
      const planKey = item.planSlug ? planKeyFromSlug(item.planSlug) : null;

      let row = await ctx.db
        .query("subscriptions")
        .withIndex("by_scopeId_and_clerkSubscriptionItemId", (q) =>
          q
            .eq("scopeId", item.scopeId)
            .eq("clerkSubscriptionItemId", item.clerkSubscriptionItemId),
        )
        .first();

      if (row === null && item.planSlug) {
        const unmatched = await ctx.db
          .query("subscriptions")
          .withIndex("by_scopeId", (q) => q.eq("scopeId", item.scopeId))
          .take(20);
        row =
          unmatched.find(
            (r) =>
              r.clerkPlanSlug === item.planSlug &&
              r.clerkSubscriptionItemId === undefined,
          ) ?? null;
      }

      // Fields present on every event. Undefined ones are left alone.
      const common = {
        clerkSubscriptionItemId: item.clerkSubscriptionItemId,
        status: item.status,
        ...(item.clerkSubscriptionId && {
          clerkSubscriptionId: item.clerkSubscriptionId,
        }),
        ...(item.currentPeriodStart !== undefined && {
          currentPeriodStart: item.currentPeriodStart,
        }),
        ...(item.currentPeriodEnd !== undefined && {
          currentPeriodEnd: item.currentPeriodEnd,
        }),
      };

      if (row !== null) {
        await ctx.db.patch("subscriptions", row._id, {
          ...common,
          // Only when the event names a plan we recognise.
          ...(planKey && item.planSlug
            ? { planKey, clerkPlanSlug: item.planSlug, features: item.features }
            : {}),
        });
      } else if (planKey && item.planSlug) {
        await ctx.db.insert("subscriptions", {
          scopeId: item.scopeId,
          scopeKind: item.scopeKind,
          planKey,
          clerkPlanSlug: item.planSlug,
          features: item.features,
          ...common,
        });
      } else {
        // Unknown plan, or an item event for an item we never saw. Nothing
        // safe to write; a later subscription.* event will carry the plan.
        console.warn(
          `Skipping subscription item ${item.clerkSubscriptionItemId}: ` +
            (item.planSlug ? `unrecognised plan "${item.planSlug}"` : "no plan and no existing row"),
        );
      }
    }
  },
});
