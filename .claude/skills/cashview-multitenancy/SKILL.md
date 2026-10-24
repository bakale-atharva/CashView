---
name: cashview-multitenancy
description: CashView's tenant isolation, roles and plan enforcement on Convex — scoped function builders, row-level security, scope from the Clerk JWT, capabilities, triggers for audit logs, usage counters and derived balances, entitlements and quotas. Use when adding a table, a query or mutation, a cron or webhook write, a role or permission, a plan feature or limit, or anything touching scopeId.
---

# Multi-tenancy, roles and plans

Authority: `convex/lib/functions.ts`, `scope.ts`, `tables.ts`, `triggers.ts`, `entitlements.ts`, `validators.ts`. Tests: `convex/tenancy.test.ts`, `convex/lib/scope.test.ts`, `convex/entitlements.test.ts`.

## The model

- **A scope is one set of books**: a Clerk org (`scopeKind: "org"`, `scopeId` = org id) or a personal workspace (`"user"`, `scopeId` = user id). `scopeFromIdentity` builds it from the verified JWT only. A malformed org claim fails closed (`UNAUTHENTICATED`) and never falls back to personal scope.
- **Every tenant row carries `scopeId` + `scopeKind`**, and every index starts with `scopeId`.
- **Never use raw `query`/`mutation`/`action`** for authenticated code. Use `scopedQuery`, `scopedMutation`, `orgOnlyMutation`, `scopedAction`. Crons and webhooks use `internalScopedMutation`/`internalScopedQuery` with `systemScope(doc)`. No public function takes a `scopeId` argument.
- **Two layers of protection**: the builder injects `ctx.scope`, and `ctx.db` is wrapped in row-level security (`rules` in `functions.ts`, `defaultPolicy: "deny"`). A query that forgets its `scopeId` filter returns nothing instead of leaking.
- **By-id reads** use `getInScope(ctx, table, id)`. Missing and foreign rows both throw `NOT_FOUND`, so ids can't be probed.

## Adding a table

1. Add `scopeId`/`scopeKind` and `by_scopeId_…` indexes in `schema.ts`.
2. Add it to `WRITABLE_TENANT_TABLES` or `READ_ONLY_TENANT_TABLES` in `tables.ts`. This also registers the `SCOPE_IMMUTABLE` trigger.
3. Add a rule in `functions.ts`: `readWrite`, `readOnly`, or `insertIf(check)` for plan-gated inserts.
4. If users edit it, add it to `AUDITED` in `triggers.ts` (with `ignore` for bookkeeping fields).

## Roles and capabilities

`owner ⊃ admin ⊃ accountant ⊃ viewer` (`CAPABILITIES` in `scope.ts`). Unknown Clerk role slugs map to `viewer`. Check permission with `requireCapability(ctx.scope, "x.y")` at the top of every write. Owner-only: billing, org delete, ownership transfer.

## Triggers (same transaction as the write)

- Audit row for every user-visible change, with field diffs and the actor.
- `usageCounters`: clients count all-time; invoices count per month of **creation** (so backdating can't dodge the quota).
- Derived money: `invoice.paidCents` = Σ payments; client `totalBilledCents`/`totalPaidCents`/`outstandingCents` from issued invoices. Never patch these by hand.
- Triggers use `ctx.innerDb`. Webhook sync writes the raw db on purpose and skips triggers.

## Plans

`PLAN_LIMITS` in `entitlements.ts` is the only place limits live. Plans come from the `subscriptions` table (Clerk Billing webhooks), never from the JWT. `active` and `canceled` (paid through the period) entitle; anything else falls back to Free. `requireFeature` and `assertQuota` throw a typed `UPGRADE_REQUIRED` that the UI turns into an upgrade prompt. Quota checks for inserts run inside the RLS `insertIf` rule, so no write path can skip them.
