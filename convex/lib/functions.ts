import { ConvexError } from "convex/values";
import {
  customAction,
  customMutation,
  customQuery,
} from "convex-helpers/server/customFunctions";
import {
  wrapDatabaseReader,
  wrapDatabaseWriter,
} from "convex-helpers/server/rowLevelSecurity";
import type { Rules } from "convex-helpers/server/rowLevelSecurity";
import { writerWithTriggers } from "convex-helpers/server/triggers";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import type {
  DatabaseReader,
  DatabaseWriter,
  MutationCtx,
  QueryCtx,
} from "../_generated/server";
import { assertQuota, requireFeature } from "./entitlements";
import { requireScope } from "./scope";
import type { TenantTable } from "./tables";
import { triggers } from "./triggers";
import { vScope } from "./validators";
import type { Scope } from "./validators";

/**
 * The builders every authenticated function is made from.
 *
 * The scope arrives through the builder, so a handler cannot be written that
 * forgets it, and no public function declares a `scopeId` argument, so there
 * is nothing for a crafted request to override. Independently of that, `db`
 * is wrapped in row-level security: a query that forgets its `scopeId` index
 * filter returns nothing rather than another organization's rows. Leaking
 * data now takes two separate mistakes.
 */

// `db` is the unwrapped reader, for rules that must look something up (the
// plan and usage counters). Rules do not apply recursively to their own reads.
type RuleCtx = { scope: Scope; db: DatabaseReader };
type Tenanted = { scopeId: string; scopeKind?: Scope["scopeKind"] };

const inScope = async ({ scope }: RuleCtx, doc: Tenanted) =>
  doc.scopeId === scope.scopeId &&
  (doc.scopeKind === undefined || doc.scopeKind === scope.scopeKind);
const never = async () => false;

const readWrite = { read: inScope, modify: inScope, insert: inScope };
// Written elsewhere (webhook sync, triggers); scoped functions may only read.
const readOnly = { read: inScope, modify: never, insert: never };

/**
 * An insert that must also clear a plan check. Runs after the scope check, so
 * a foreign-scope insert still fails as "not allowed", and before the write,
 * so a refused insert leaves nothing behind. Because it lives here rather
 * than in each mutation, no write path (user, cron, webhook) can skip it.
 */
const insertIf = (check: (ctx: RuleCtx) => Promise<unknown>) => ({
  ...readWrite,
  insert: async (ctx: RuleCtx, doc: Tenanted) => {
    if (!(await inScope(ctx, doc))) return false;
    await check(ctx);
    return true;
  },
});

const rules: Rules<RuleCtx, DataModel> = {
  scopeSettings: readWrite,
  clients: insertIf((ctx) => assertQuota(ctx, "clients")),
  invoices: insertIf((ctx) => assertQuota(ctx, "invoices")),
  invoiceLineItems: readWrite,
  payments: readWrite,
  recurringInvoices: insertIf((ctx) => requireFeature(ctx, "recurring_invoices")),
  recurringLineItems: insertIf((ctx) => requireFeature(ctx, "recurring_invoices")),
  expenses: readWrite,
  expenseCategories: readWrite,
  usageCounters: readOnly,
  auditLogs: readOnly,
  memberships: readOnly,
  subscriptions: readOnly,
};

// Tables with no rule (users, organizations) are inaccessible to scoped code.
const rlsConfig = { defaultPolicy: "deny" } as const;

function scopedReader(ctx: QueryCtx, scope: Scope): DatabaseReader {
  return wrapDatabaseReader({ scope, db: ctx.db }, ctx.db, rules, rlsConfig);
}

function scopedWriter(ctx: MutationCtx, scope: Scope): DatabaseWriter {
  // Row-level security on the outside, so triggers only fire for writes that
  // were permitted. Triggers themselves use the unwrapped db.
  const withTriggers = writerWithTriggers({ db: ctx.db, scope }, ctx.db, triggers);
  return wrapDatabaseWriter({ scope, db: ctx.db }, withTriggers, rules, rlsConfig);
}

function requireOrg(scope: Scope): void {
  if (scope.scopeKind !== "org") {
    throw new ConvexError({ code: "ORG_REQUIRED" });
  }
}

/** Every authenticated read. */
export const scopedQuery = customQuery(query, {
  args: {},
  input: async (ctx) => {
    const scope = await requireScope(ctx);
    return { ctx: { scope, db: scopedReader(ctx, scope) }, args: {} };
  },
});

/** Every authenticated write. `db` runs audit, counter and balance triggers. */
export const scopedMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const scope = await requireScope(ctx);
    return { ctx: { scope, db: scopedWriter(ctx, scope) }, args: {} };
  },
});

/** Writes that only make sense for an organization (members, org settings). */
export const orgOnlyMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const scope = await requireScope(ctx);
    requireOrg(scope);
    return { ctx: { scope, db: scopedWriter(ctx, scope) }, args: {} };
  },
});

/** Actions have no `ctx.db`; they get the scope and reach data via internals. */
export const scopedAction = customAction(action, {
  args: {},
  input: async (ctx) => {
    return { ctx: { scope: await requireScope(ctx) }, args: {} };
  },
});

/**
 * For trusted callers with no user session: crons, webhook handlers, seeding.
 * The scope is passed explicitly, so these must stay internal. They get the
 * same row-level security and triggers as user-driven writes.
 */
export const internalScopedMutation = customMutation(internalMutation, {
  args: { scope: vScope },
  input: async (ctx, { scope }) => {
    return { ctx: { scope, db: scopedWriter(ctx, scope) }, args: {} };
  },
});

export const internalScopedQuery = customQuery(internalQuery, {
  args: { scope: vScope },
  input: async (ctx, { scope }) => {
    return { ctx: { scope, db: scopedReader(ctx, scope) }, args: {} };
  },
});

/**
 * By-id read that fails loudly. Row-level security already hides other
 * tenants' rows (a bare `db.get` returns null for them), so this exists for a
 * clear error. Missing and foreign rows are indistinguishable on purpose, so
 * the response cannot be used to probe for ids in other organizations.
 */
export async function getInScope<T extends TenantTable>(
  ctx: { db: DatabaseReader; scope: Scope },
  table: T,
  id: Id<T>,
): Promise<Doc<T>> {
  const doc = await ctx.db.get(table, id);
  // Checked again explicitly: cheap, and holds even if `db` were ever unwrapped.
  if (doc === null || doc.scopeId !== ctx.scope.scopeId) {
    throw new ConvexError({ code: "NOT_FOUND", table });
  }
  return doc;
}
