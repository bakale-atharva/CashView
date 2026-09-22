# Clerk dashboard configuration (Phase B3)

This documents the Clerk configuration CashView depends on: what is done, what
was fixed in this phase, and what is still a manual dashboard step because the
Backend/Platform API refuses it on this account. It replaces guessing with a
verified state, read back from Clerk after every change below.

Instance: `trusty-oyster-6712` (development). All values here are for that
instance; production is configured separately when the app deploys (B3 is
explicitly re-done by hand there — dev plans do not migrate).

## What this phase did

Most of B3 was already in place before this PR — organizations, billing, the
nine Features, all six Plans, the `Owner` role, and the webhook endpoint had
already been configured by hand in the dashboard. This phase:

1. **Audited it against the plan and against Convex's own source of truth**
   (`convex/lib/entitlements.ts`'s `PLAN_LIMITS`), using the Clerk CLI's
   `config pull` / `config patch` rather than clicking through the dashboard
   blind.
2. **Found and fixed one real bug**: `free_org` carried two Features it must
   not have, and `business_org` carried none of the nine it must have. See
   [Bug found and fixed](#bug-found-and-fixed-free_org--business_org-features).
3. **Determined which remaining pieces can and cannot be automated** on this
   account (see [Confirmed API-only](#confirmed-api-only-not-a-guess)), and
   wrote up the exact manual steps for what's left, in the same copy the plan
   specifies, so nothing needs to be reworded when you do it.

## B3.1 — Organizations: enabled, membership optional

Read back via `clerk config pull`:

```json
"organization_settings": {
  "enabled": true,
  "force_organization_selection": false,
  "organization_creation_defaults": { "enabled": true },
  "max_allowed_memberships": 5
}
```

`force_organization_selection: false` is what "Membership optional" means in
the API — personal accounts stay reachable, which is required for personal
scope (decision A1). This was already set correctly.

## B3.2 — Billing: enabled

```json
"billing": { "organization_enabled": true, "user_enabled": true }
```

Both organization and user billing are on.

## B3.3 / B3.5 — Roles: Owner and Admin exist and are in use; Accountant and Viewer are not confirmed

The creator role is `org:owner`:

```json
"organization_settings": { "creator_role": "org:owner" }
```

Membership roles actually in use, read via the Backend API
(`GET /v1/organizations/{id}/memberships`) across all three seed orgs:

| Organization | Member | Role |
|---|---|---|
| Acme Inc. | `bakaleatharva13@gmail.com` | `org:owner` |
| NVIDIA Graphics | `atharvabakale13@gmail.com` | `org:owner` |
| NVIDIA Graphics | `bakaleatharva13@gmail.com` | `org:admin` |
| Atharva Bakale Industries | `atharvabakale13@gmail.com` | `org:owner` |

`org:owner` and `org:admin` exist and work. **There is no way to list an
instance's defined roles via the API** (see below), so I cannot confirm
whether `org:accountant` and `org:viewer` already exist unused, or don't exist
at all — no membership uses either. Treat them as not yet created until you
check.

### Still to do by hand — Roles

**Navigate:** Configure → Organization Settings → Roles & Permissions → Roles

Create these two if `clerk api ls role` and the dashboard's role list don't
already show them (exact copy, unchanged from the plan):

**Accountant — `org:accountant`**
> Full bookkeeping, no administration. Create, edit, send, void and delete invoices; record and reverse payments; add, edit and archive clients; log expenses, upload receipts and run receipt scanning; manage recurring schedules; and read every report. Cannot manage members, change settings or branding, see billing, or read the audit trail. The right default for in-house finance staff and external accountants.

**Viewer — `org:viewer`**
> Read-only access to the books. Open invoices with their line items and payment history, browse clients and outstanding balances, view expenses and receipts, and read every report and dashboard chart. Every write is refused by the server, not merely hidden in the interface. Cannot record payments, upload anything, change settings, manage members, see billing, or read the audit trail. For investors, advisors and auditors.

Leave Clerk's built-in `org:member` alone and never assign it — Convex maps
it, and any role it doesn't recognise, to Viewer, so an unexpected role fails
closed rather than open (see `convex/lib/scope.ts`).

**This does not block anything already built.** `roleFromClerkSlug()` already
maps `owner`, `admin`, `accountant`, `viewer` correctly (B1/B4); creating the
roles in Clerk just makes them assignable to real members. Until then, every
member of every org is Owner or Admin, which is already true today.

### Permissions (optional, cosmetic — not load-bearing)

Per architecture decision A3, Convex never reads Clerk permissions; it reads
the role slug and applies its own capability matrix. Custom permissions exist
only so the Next.js layer can use `has({ permission })` for UI gating later
(F-phases). The full matrix (13 custom permissions across 7 features, plus
which of the 9 system permissions each role should carry, including editing
`org:admin`'s built-ins) is in `.claude/plans/PLAN.md` § B3.4. Confirmed
API-only (see below) — do this by hand only if/when the frontend wants
`has({ permission })` checks; nothing backend depends on it.

## B3.5 / B3.6 — Seat caps: not set per plan

The plan wants Free/Pro/Business org plans capped at 1/5/20 seats. The
`billing.plans.*` object returned by `clerk config pull` has no seat/cap field
at all (checked against the full config JSON Schema, not just the current
values — see below), so this is not settable through the API on this account.

**Still to do by hand — Seat caps**

**Navigate:** Configure → Billing → Plans → Organization Plans tab → each plan

| Plan | Seats |
|---|---|
| `free_org` | 1 |
| `pro_org` | 5 |
| `business_org` | 20 (Clerk's cap without the paid B2B Authentication add-on — this is why `PLAN_LIMITS.business.orgSeats` in `convex/lib/entitlements.ts` is `20`, not `Infinity`) |

Clerk enforces this at invite time; nothing in Convex needs to change once
it's set.

## B3.7 / B3.8 — Webhook: endpoint configured, secret set, delivery unverified

`CLERK_WEBHOOK_SECRET` is set in the **Convex** environment (confirmed via
`npx convex env list` — not `.env.local`, which the handler in
`convex/http.ts` never reads). The endpoint itself isn't listable through the
Backend API (Clerk manages webhook endpoints through Svix, and the CLI's
catalog only exposes `POST/DELETE /webhooks/svix*`, not a CRUD list), so this
is the one thing here I could not read back — only infer from the secret
being set.

**No delivery has been logged yet** (`npx convex logs` shows no
`clerk-webhook` activity). That could mean the endpoint isn't correctly
pointed at the `.site` domain, or simply that nothing has triggered a
subscribed event since it was created.

**Still to do — verify delivery**

1. In Clerk's webhook page, **Send test event** with `user.created`. Should
   return **200**.
2. Tell me — I'll check `npx convex logs` for the delivery and report back.

If it's not 200: **401** means the secret is wrong or unset; **404** means the
endpoint is pointed at `.cloud` instead of `.site`.

## Bug found and fixed: `free_org` / `business_org` features

Read via `clerk config pull` before this phase, against
`convex/lib/entitlements.ts`'s `PLAN_LIMITS` (the actual source of truth
Convex enforces):

| Plan | Should carry | Actually carried |
|---|---|---|
| `free_org` | the 5 core features only | the 5 core **plus `multi_currency` and `receipt_scanning`** |
| `pro_org` | core + `reports`, `recurring_invoices` | correct |
| `business_org` | all 9 | **none** |
| `free_user` | the 5 core | correct |
| `pro_user` | core + `reports`, `recurring_invoices` | correct |
| `business_user` | all 9 | correct |

Only the two organization plans were wrong — the user plans were already
right. This wouldn't have broken anything Convex enforces (Convex computes
its own entitlements from the `planKey`, never from Clerk's Feature list —
architecture decision A3), but it would have made any future `has({ feature
})` UI check on the frontend wrong for organizations specifically: a Free org
would have looked like it had multi-currency and receipt scanning, and a
Business org would have looked like it had nothing.

Fixed with `clerk config patch` (dry-run first, diff below, then applied):

```
billing:
  plans.free_org.features:
    - ["multi_currency","receipt_scanning","invoices","expenses","clients","settings","audit"]
    + ["invoices","expenses","clients","settings","audit"]
  plans.business_org.features:
    - []
    + ["invoices","expenses","clients","settings","audit","reports","recurring_invoices","receipt_scanning","multi_currency"]
```

Read back afterward and confirmed both plans now carry exactly the feature
set `PLAN_LIMITS` expects.

## Confirmed API-only (not a guess)

These returned a genuine `404` from `api.clerk.com` itself (Cloudflare edge,
not an app-level error) on every path tried, including the exact paths this
skill's own reference docs give:

- `GET /v1/organization_roles`, `GET /organization_roles` — listing/creating
  custom roles
- `GET /v1/organization_permissions`, `GET /organization_permissions` —
  listing/creating custom permissions
- `GET /v1/role_sets` — role sets
- `GET --fapi /v1/environment` — tried as a fallback read of the role catalog

And confirmed absent from the config schema itself (not just unset): no
seat/cap/quantity field exists anywhere under `billing.plans.*` in
`clerk config schema --keys billing`.

Conclusion: role, permission, and seat-cap management are Dashboard-UI-only
on this Clerk account/plan. This matches the plan's own honest flag on
editing `org:admin`'s built-in permissions — the same constraint turned out to
be broader than just that one case.

## Verification checklist

- [x] Organizations enabled, membership optional
- [x] Billing enabled for organizations and users
- [x] `org:owner` is the creator role, confirmed via config read-back
- [x] `org:owner` and `org:admin` confirmed in active use via real membership
      data across all three seed orgs
- [x] All 9 Features exist with the plan's exact copy
- [x] All 6 Plans exist with the plan's pricing
- [x] `free_org` and `business_org` feature lists fixed and read back
- [x] `CLERK_WEBHOOK_SECRET` confirmed set in the Convex environment
- [ ] `org:accountant` and `org:viewer` roles created (dashboard-only)
- [ ] Seat caps set on `free_org` (1), `pro_org` (5), `business_org` (20)
      (dashboard-only)
- [ ] Webhook delivery verified end to end (send a test event, then ask me to
      check the logs)
- [ ] Optional: 13 custom permissions + system-permission edits on `org:admin`
      (B3.4) — cosmetic only, no backend dependency, do this later if/when F7
      wants `has({ permission })`

**Acceptance, per the plan:** "I read the config back through the Clerk
Backend API and diff it against the tables above." Done for everything the
API exposes; the three remaining items are the ones the API doesn't expose on
this account, and are checklist items above rather than something I can read
back.
