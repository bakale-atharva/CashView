# CashView — Implementation Plan

## Context

CashView is a B2B accounting SaaS (QuickBooks/Xero class): invoicing, expense tracking, client management, and financial reporting. The repo today is a bare scaffold — `create-next-app` (Next 16.3.5 / React 19.2.8) with Clerk sign-in/sign-up pages, a Convex project that has `auth.config.ts` but **no schema and no functions**, and exactly one shadcn component (`Button`). `app/page.tsx` is still Next.js boilerplate. Two things are actively broken: the font and `pnpm lint`.

The goal is a complete, working, multi-tenant product where:

- **Clerk Organizations are optional.** A user can work in a personal scope or inside an org. Data must never leak between scopes.
- **Every authorization decision is made server-side in Convex**, derived from the JWT — never from a client-supplied id.
- **Clerk Billing** drives three tiers whose limits are enforced in Convex, not merely hidden in the UI.
- The UI is designed through the **impeccable** skill at full ritual, not assembled from default shadcn blocks.

Work proceeds **backend first, then frontend**, one phase per branch, each ending in a PR you review and merge before the next begins.

### Decisions locked with you

| Decision | Choice |
|---|---|
| Invoice delivery | **Link-only.** "Send" flips status and mints a public share link. No email, no Resend, no email keys. |
| PDF generation | **`@react-pdf/renderer`**, server-side in a Next.js route handler. |
| Currency / locale | **USD, `en-US`** base. Multi-currency is the Business-tier feature. |
| Design process | **Full impeccable ritual** — `init` → direction round → surface briefs → comps → finish review. |
| AI provider | **OpenRouter free vision models** for receipt OCR. |
| Clerk setup | **Manual, via dashboard.** No Clerk CLI. Every field is spelled out in Phase B3. |
| Clerk instance | **Development only** (`pk_test_`/`sk_test_`). Billing runs on Clerk's shared dev gateway; no Stripe account needed. |
| Authz model | **Decoupled.** Roles come from the JWT; entitlements come from a webhook-synced Convex table. |
| Billing shape | **Two parallel plan families.** Three organization plans *and* three user plans, because personal scope is a first-class workspace that must be upgradable on its own. |
| Backend library | **`convex-helpers`** for custom function wrappers, row-level security, and triggers — see A4. |
| Frontend motion, charts, components | **Motion** (`motion.dev`, the current name for Framer Motion) for every animation; **Bklit UI** (`ui.bklit.com`) for chart primitives; **Kokonut UI** (`kokonutui.com`) for interactive component patterns to adapt. All three sit *under* shadcn/ui, not beside it, and none ship in their own default look — see A5. |
| Git workflow | One branch per phase → PR → you review → you merge. Never merge unreviewed. |

### Seed targets

| Organization | Tier |
|---|---|
| Acme Inc. | Free |
| Atharva Bakale Industries | Pro |
| NVIDIA Graphics | Business |

Both `atharvabakale13@gmail.com` and `bakaleatharva13@gmail.com` get membership in all three, plus a personal-scope dataset each.

---

## Architecture decisions that shape everything downstream

These four are the load-bearing ones. Everything else follows from them.

### A1. Scope, not `orgId`

Your spec says "every table has an `orgId` field." Taken literally that breaks optional membership — personal-scope rows would need `orgId: null`, and a nullable index prefix is both awkward to query and easy to get wrong in a way that leaks data.

Instead every table carries:

```ts
scopeId: v.string(),                                    // "org_abc..." or "user_xyz..."
scopeKind: v.union(v.literal("org"), v.literal("user")),
```

`scopeId` is the Clerk org id when an org is active, and the Clerk user id otherwise. **Every index begins with `scopeId`.** This satisfies the isolation requirement more strictly than a nullable `orgId` would: there is exactly one code path, and personal data is scoped by the same mechanism as org data rather than by a special case.

### A2. The org claim is nested, and its exact Convex shape must be measured before anything depends on it

Current Clerk session tokens (API version 2025-04-10+) do **not** emit flat `org_id` / `org_role` / `org_permissions`. They emit one compact claim, present only when an organization is active:

```jsonc
"o": { "id": "org_123", "rol": "admin", "per": "invoices:manage,...", "slg": "acme", "fpm": "1" }
```

Note `rol` and `per` arrive **without** the `org:` prefix. Convex's `UserIdentity` type only guarantees `tokenIdentifier` / `subject` / `issuer`, and whether it surfaces this as a nested `identity.o` object or a flattened `identity["o.id"]` key is **not documented**. Older tutorials referencing `sessionClaims['org_id']` describe a legacy token version and must not be trusted.

**Therefore Phase B1 opens with an empirical probe**, before a single line of authz logic is written: a throwaway public query that logs `JSON.stringify(await ctx.auth.getUserIdentity())`, run once with an org active and once in personal scope. The real shape it returns is what `requireScope()` gets written against. This is a deliberate gate — guessing here produces an authorization bug that looks like it works.

### A3. Entitlements come from a synced table, not from JWT claims

Clerk's session token does carry `pla` and `fea` claims, but Clerk's own guidance is that reading plan data out of session claims is **not a supported path** — the supported reader is `has({ plan })` / `has({ feature })`, which only exists inside Clerk's own SDK and therefore cannot run inside Convex.

So Convex gets entitlements from a `subscriptions` table populated by Clerk Billing webhooks. This is also the only option that supports **quota** limits ("5 clients", "10 invoices/month"), which are counts the JWT could never carry.

This also sidesteps a coupling that would otherwise bite. In Clerk a permission is `org:<feature>:<action>`, and `has({ permission })` returns `false` unless that **feature** is attached to the payer's active plan. B3 turns that coupling into an asset by splitting features into core (on every plan) and premium (paid only), so `org:reports:read` is automatically false on Free. But it only works inside Clerk's own SDK. Convex cannot call `has()` at all, so it maps the **role slug** (`o.rol`) through a capability matrix in code and reads entitlements from the synced `subscriptions` row. Clerk permissions stay useful for UI gating in Next.js and are never load-bearing for security.

### A4. `convex-helpers` carries the tenancy plumbing

[`convex-helpers`](https://github.com/get-convex/convex-helpers) (v0.1.124, peer `convex ^1.43.0` — we are on 1.46.0) is a first-party Convex library of patterns that would otherwise be hand-rolled here. Four of its modules map directly onto requirements in your spec, and using them turns rules that would be *conventions enforced by code review* into rules that are *structurally impossible to violate*. It is added in Phase 0 and used from B1 onward.

**`convex-helpers/server/customFunctions` — the scope never has to be remembered.** Instead of every function starting with a hand-written `const scope = await requireScope(ctx)` that a future edit could forget, we define the wrappers once:

```ts
export const scopedQuery    = customQuery(query,       { args: {}, input: async (ctx) => ({ ctx: { ...ctx, scope: await requireScope(ctx) }, args: {} }) });
export const scopedMutation = customMutation(mutation, { /* … plus capability + audit context */ });
```

Every handler then receives `ctx.scope` already resolved and type-safe. This is what actually delivers decision A1's promise: a function *cannot* be written without a scope, because the scope arrives through the constructor rather than through discipline. Public unscoped functions become the conspicuous exception (`convex/public.ts`) rather than the silent default.

**`convex-helpers/server/rowLevelSecurity` — defence in depth on the database itself.** `wrapDatabaseReader` / `wrapDatabaseWriter` attach per-table read and write predicates to `ctx.db`, so a query that forgets its `scopeId` filter returns nothing rather than returning another organization's rows. Your spec calls for "no cross-org data leakage"; the index discipline in A1 is the primary defence and this is the second, independent one behind it. A leak now requires two separate mistakes.

**`convex-helpers/server/triggers` — audit trail and counters stop drifting.** Triggers run registered code on every insert, patch, replace, and delete of a table, inside the same transaction as the write. This is a much better fit for two requirements than hand-calling helpers:

- **Audit trail** — instead of remembering `writeAudit(...)` in nineteen mutations, one trigger per audited table records who changed what, with the before and after documents both available. A mutation cannot be written that skips the audit, because the audit is not in the mutation.
- **Denormalized counters and balances** — `usageCounters`, and the `outstandingCents` / `totalBilledCents` / `totalPaidCents` fields on `clients`, update from triggers on the source tables. The Convex guidelines specifically warn that denormalized values drift when they are updated somewhere other than the source write; a trigger is the same transaction by construction.

**`convex-helpers/server/relationships` and `/stream`** — `getManyFrom` for an invoice's line items, `getAll` for resolving client references on an invoice list without an N+1 pattern, and `stream` for the merged, index-backed pagination the invoice list needs once filters and sorting are combined.

Also used where they fit: `convex-helpers/validators` (`literals`, `nullable`, `brandedString`) to tighten the schema, and `convex-helpers/server/pagination` where a plain paginated query is enough.

**Not used, and why:** the `sessions`, `hono`, `cors`, `retries`, `rateLimit`, and `migrations` modules are out of scope — Clerk owns sessions, we have no Hono router, the only cross-origin surface is the public invoice link, and the retry/rate-limit/migration concerns have since moved to dedicated `@convex-dev/*` components that we would reach for instead if they became necessary. `crud` is deliberately avoided: it generates unscoped CRUD endpoints, which is precisely the shape this application must not have.

### A5. Three frontend libraries sit underneath shadcn, not beside it

F0 locked a specific, bespoke visual world — **Certified Ledger**: rubber-stamp status marks, ruled paper, one stamp-red accent, a five-color status vocabulary, Public Sans throughout (`.impeccable/surfaces/app.md`, `DESIGN.md`). None of the three libraries below may be dropped in with their own default theme; each earns its place only where it saves real engineering work (motion primitives, chart math, interaction patterns), and every visible surface it produces gets re-skinned to the tokens in `app/globals.css` before it ships.

- **Motion** (`motion.dev`, package `motion` — the current name for what shipped as Framer Motion) is the animation primitive for the whole app: the sidebar reveal, hover/focus/active transitions, and — the signature interaction the direction contract calls for — the **stamp-strike**, a short, orchestrated animation (scale + slight rotation + an ink-impact flash) that plays when an invoice flips to Sent, Paid, or Void, dramatizing the direction's own metaphor rather than decorating it. Governed by Operate mode's 150–250ms budget (`reference/operate.md`); one authored moment per state change, never scattered hover effects.
- **Bklit UI** (`ui.bklit.com`) supplies composable chart primitives — root chart, `Grid`, series, axes, `ChartTooltip` — as shadcn registry components (add the `@bklit` namespace to `components.json`, then `npx shadcn@latest add @bklit/<chart>` per chart; each chart pulls its own Visx + `motion` peers, so it is the same Motion dependency as A5's first bullet, not a second animation library). It replaces hand-rolling chart math for F2 (dashboard) and F6 (reports). Theming goes through Bklit's own `chartCssVars` export and the `--chart-1` … `--chart-5` tokens already defined in `app/globals.css` (never a raw `var(--chart-…)` string or a hardcoded hex) — mapped to the app's status colors where a chart is status-shaped, and to `--chart-1..5` otherwise; tooltip surfaces use `bg-popover text-popover-foreground`, not Bklit's own defaults. Axis/label type is Public Sans. The `dataviz` skill still governs composition, density, and layout regardless of which primitives assemble the chart.
- **Kokonut UI** (`kokonutui.com`) is a reference source for interaction *patterns* — command palettes, animated cards, richly-stated empty/loading treatments — installed piecemeal via the shadcn CLI and treated as a structural starting point, never a finished component. **Its own default look is a dark, near-black zinc canvas with Geist typography** — the opposite of this app's pale-ledger, Public Sans world — so every component pulled from it is re-colored, re-typeset, and re-radiused to the design system before it's considered done; a Kokonut component still wearing its own theme in a PR is a review-blocking defect, not a style nit.
- **shadcn/ui** (already in place, on Base UI) remains the base component layer everything above composes with, per the existing setup.

---

# PART I — BACKEND

## Phase 0 — Foundation & housekeeping

**Branch:** `chore/phase-0-foundation`

### 0.1 The font is broken — root cause confirmed

`app/layout.tsx` defines `--font-geist-sans` / `--font-geist-mono`, but [app/globals.css:10](app/globals.css) declares:

```css
--font-sans: var(--font-sans);   /* self-referential → resolves to nothing */
```

Nothing else defines `--font-sans` — verified that `shadcn/dist/tailwind.css` contains no font declarations at all. So `font-sans` on `<html>` emits an empty `font-family` and the browser falls back to its default serif.

**Fix** in the `@theme inline` block:

```css
--font-sans: var(--font-geist-sans);
--font-mono: var(--font-geist-mono);
--font-heading: var(--font-sans);
```

This is the correctness fix only. The typeface itself is re-decided in Phase F0 — Geist is a placeholder, not a commitment.

### 0.2 `pnpm lint` crashes — root cause confirmed

Reproduced:

```
TypeError: Error while loading rule 'react/display-name':
contextOrFilename.getFilename is not a function
  at resolveBasedir (eslint-plugin-react/lib/util/version.js:31)
  at detectReactVersion (.../version.js:85)
```

`eslint-config-next@16.3.5` sets `settings.react.version = 'detect'` (`eslint-config-next/dist/index.js:143`). That makes `eslint-plugin-react@7.37.5` call `context.getFilename()`, which **ESLint 10 removed**. `eslint-plugin-react` has no ESLint 10-compatible release — latest peer range is `eslint: ^9.7`, so there is nothing to upgrade *to*.

**Fix — no downgrade, no version override, no new dependency.** Reading `eslint-plugin-react/lib/util/version.js:109-125`, `detectReactVersion()` is reached *only* when `settings.react.version === 'detect'`. Pinning an explicit version short-circuits the broken path entirely. Append to [eslint.config.mjs](eslint.config.mjs):

```js
{ settings: { react: { version: "19.2.8" } } },
```

Also extend `globalIgnores` — ESLint is currently walking `.agents/skills/**` and linting Clerk's bundled template files, which is what surfaced the crash first:

```js
globalIgnores([
  ".next/**", "out/**", "build/**", "next-env.d.ts",
  ".agents/**", ".claude/**", "convex/_generated/**", ".impeccable/**",
]),
```

And give the script a target: `"lint": "eslint ."`.

**Acceptance:** `pnpm lint` exits 0 with ESLint 10.11.0 and `eslint-config-next` 16.3.5 both still pinned exactly as installed.

### 0.3 Convex client provider is missing

`layout.tsx` wraps in `ClerkProvider` but there is no `ConvexReactClient`, so no component can call Convex. Add `components/convex-client-provider.tsx` (a Client Component — `ConvexReactClient` cannot be constructed server-side) using `ConvexProviderWithClerk` from `convex/react-clerk` with `useAuth` from `@clerk/nextjs`, nested **inside** `ClerkProvider`.

### 0.4 `middleware.ts` does not exist

No route protection anywhere. Add `clerkMiddleware` with a public matcher covering the marketing page, sign-in/sign-up, the **public invoice link** (`/i/:token`), and the PDF route; everything under `/app` is gated.

### 0.5 Also here

- Add **`convex-helpers`** (see architecture decision A4) — it underpins the tenancy core in B1, the audit trail and counters in B4, and the relationship and pagination helpers used from B5 onward.
- Add `svix` (needed in Phase B2 — `verifyWebhook` from `@clerk/nextjs/webhooks` is Next-request-shaped and does not work inside a Convex httpAction).
- Pin `@clerk/nextjs` to an exact version. Clerk Billing is explicitly experimental and Clerk's own guidance is to pin.
- `.env.example` covering every key in `.env.local` plus `CLERK_WEBHOOK_SECRET` and `OPENROUTER_API_KEY`.
- Commit the `AGENTS.md` / `CLAUDE.md` churn `next dev` regenerates, so the tree is clean.

**Acceptance:** `pnpm lint` passes, `pnpm build` passes, app renders in Geist, signed-in user reaching `/app` is not bounced.

---

## Phase B1 — Identity probe, schema, and the tenancy core

**Branch:** `feat/b1-schema-tenancy`

This is the most important backend phase. Everything after it is mechanical by comparison.

### B1.0 The probe (gate — do this first)

Temporary `convex/debug.ts` with a public query logging the full identity object. Run signed-in **with an org active** and **in personal scope**, record both shapes in the PR description, then write `requireScope()` against what was actually observed and delete the probe before merge.

### B1.1 Schema — `convex/schema.ts`

Tables, each carrying `scopeId` + `scopeKind` unless noted, every index `scopeId`-prefixed:

- **`users`** — synced from Clerk. `clerkUserId`, `email`, `firstName`, `lastName`, `imageUrl`. *(Global, not scoped.)*
- **`organizations`** — synced. `clerkOrgId`, `name`, `slug`, `imageUrl`. *(Global.)*
- **`memberships`** — synced. `scopeId` (org), `clerkUserId`, `role`, `joinedAt`. Drives the team roster and seat display.
- **`subscriptions`** — synced from Billing webhooks. `scopeId`, `payerType`, `planKey` (`free`/`pro`/`business`), `clerkPlanSlug`, `status`, `features: string[]`, `currentPeriodStart/End`.
- **`usageCounters`** — `scopeId`, `metric` (`clients` | `invoices`), `period` (`"all"` or `"2026-09"`), `count`. Exists because the Convex guidelines forbid `.collect().length` for counting, and quotas need exact counts.
- **`scopeSettings`** — one doc per scope. Business identity (name, address lines, email, phone, tax id), branding (`logoStorageId`, `brandColor`, `invoiceTemplate`), and invoice defaults (`currency`, `defaultTaxRatePct`, `invoiceNumberPrefix`, `nextInvoiceSeq`, `paymentTermsDays`, `footerNote`).
- **`clients`** — contact + billing address, `currency`, `isArchived`, plus denormalized `outstandingCents` / `totalBilledCents` / `totalPaidCents`, maintained by the triggers in B1.2 so they update inside the same transaction as the invoice or payment write (the guidelines' drift rule).
- **`invoices`** — `clientId`, `invoiceNumber`, `status` (`draft`/`sent`/`viewed`/`paid`/`overdue`/`void`), `issueDate`, `dueDate`, `currency`, `exchangeRate?`, money fields in **integer cents** throughout, `publicToken` (unguessable, its own index), `sentAt`/`viewedAt`/`paidAt`, `recurringTemplateId?`.
- **`invoiceLineItems`** — child table rather than an embedded array, per the guidelines' "no unbounded arrays in a document" rule. `invoiceId`, `position`, `description`, `quantity`, `unitPriceCents`, `taxRatePct`, `amountCents`.
- **`payments`** — `invoiceId`, `clientId`, `amountCents`, `paidAt`, `method`, `reference?`. Partial payments supported; invoice status derives from the sum.
- **`recurringInvoices`** + **`recurringLineItems`** — `frequency`, `startDate`, `endDate?`, `nextRunAt`, `isActive`, template payload. Carries one deliberately **un-scoped** index `by_active_and_next_run` for the cron; it is reachable only from an `internalMutation`.
- **`expenses`** — `categoryId`, `vendor`, `amountCents`, `taxCents`, `currency`, `spentAt`, `paymentMethod`, `receiptStorageId?`, `ocrStatus`, `ocrRaw?`, `isBillable`, `clientId?`.
- **`expenseCategories`** — per-scope, seeded on first use with Rent, Software, Travel, Meals & Entertainment, Utilities, Marketing, Professional Services, Equipment, Insurance, Payroll, Taxes & Licenses, Bank Fees, Office Supplies, Other.
- **`auditLogs`** — `actorUserId`, `actorEmail`, `actorRole`, `action`, `entityTable`, `entityId`, `entityLabel`, `summary`, `changes?: {field, from, to}[]`, `at`.

### B1.2 The tenancy core, built on `convex-helpers`

Three small files, and the whole isolation guarantee lives in them.

#### `convex/lib/scope.ts` — deriving who is asking

```ts
requireScope(ctx): Promise<Scope>   // { scopeId, scopeKind, userId, role }
```

Derived from `ctx.auth.getUserIdentity()` alone, against the claim shape B1.0 actually observed. Throws `ConvexError({ code: "UNAUTHENTICATED" })` when there is no identity. `scopeId` is the organization id when the `o` claim is present, the user id otherwise.

The Convex guidelines prefer `tokenIdentifier` over `subject` as the stable ownership key. Here `subject` is used as `clerkUserId` because it is the value Clerk webhooks send and the two have to join; `tokenIdentifier` is stored alongside on the `users` row where a globally-unique key is wanted. The tension is deliberate and gets noted in the PR.

The capability matrix lives here too:

| Capability | `owner` | `admin` | `accountant` | `viewer` |
|---|:---:|:---:|:---:|:---:|
| `clients.read` · `invoices.read` · `expenses.read` · `reports.read` | ✓ | ✓ | ✓ | ✓ |
| `clients.write` · `invoices.write` · `invoices.send` · `expenses.write` · `payments.record` | ✓ | ✓ | ✓ | — |
| `settings.manage` · `members.manage` · `audit.read` | ✓ | ✓ | — | — |
| `billing.manage` · `org.delete` · `org.transferOwnership` | ✓ | — | — | — |

The role slug arrives from the JWT's `o.rol` claim **without** the `org:` prefix, so the matrix is keyed on the bare strings `owner`, `admin`, `accountant`, `viewer`. Personal scope grants everything, including `billing.manage` — you own your own workspace. Unknown or unmapped roles, including Clerk's built-in `org:member`, fall back to **viewer**, so the failure path is least privilege rather than most.

The bottom row is the Owner/Admin split, and it is enforced twice over: Clerk withholds `org:sys_billing:manage` and `org:sys_profile:delete` from Admin, and Convex refuses the capability independently so a crafted request gets nowhere either. Only the second of those is something we control — Clerk's docs do not specify whether a missing billing permission hides its UI controls or merely disables them, which B3.11 asks you to observe. Convex is the guarantee; Clerk's components are the convenience.

#### `convex/lib/functions.ts` — the wrappers every function is built from

This is the file that makes A1 structural instead of aspirational. Using `customQuery` / `customMutation` / `customAction` from `convex-helpers/server/customFunctions`, we export:

| Wrapper | What it injects | Used for |
|---|---|---|
| `scopedQuery` | `ctx.scope`, and `ctx.db` wrapped in row-level security | every authenticated read |
| `scopedMutation` | the same, plus the trigger-enabled writer and audit context | every authenticated write |
| `scopedAction` | `ctx.scope` only (actions have no `ctx.db`) | the OCR action |
| `orgOnlyMutation` | additionally refuses personal scope | member management, org settings |
| `internalScopedMutation` | scope passed explicitly by a trusted caller | cron jobs, webhook handlers, seeding |

Because the scope arrives through the wrapper, **a handler cannot be written that forgets it** — there is no code path where `ctx.scope` is absent. And because no public function declares a `scopeId` argument, there is nothing for a crafted request to override. That combination, not vigilance, is what prevents cross-tenant access.

`ctx.db` inside these wrappers is `wrapDatabaseReader` / `wrapDatabaseWriter` from `convex-helpers/server/rowLevelSecurity`, carrying a predicate per tenant table: *read and write are permitted only where `doc.scopeId === ctx.scope.scopeId`*. A query that forgets its index filter therefore returns nothing rather than another organization's rows. Two independent mistakes are now required to leak data, which is the standard this spec asks for.

A thin `getInScope(ctx, id)` remains for by-id reads that want a clear error message rather than a silent `null`.

#### `convex/lib/triggers.ts` — audit and counters, by construction

Registered through `convex-helpers/server/triggers`, running inside the same transaction as the write:

- **Audit** — one trigger per audited table writes the `auditLogs` row, with both the previous and new documents in hand so the field-level diff is computed rather than hand-assembled. No mutation can skip it, because it is not in the mutation.
- **Counters** — `usageCounters` increments and decrements from triggers on `clients` and `invoices`. Quota counts cannot drift from reality because they are not updated separately from it.
- **Client balances** — `outstandingCents`, `totalBilledCents`, and `totalPaidCents` on `clients` recompute from triggers on `invoices` and `payments`, satisfying the Convex guidelines' rule that denormalized values be updated in the same mutation as their source.

Tables carrying triggers: `clients`, `invoices`, `invoiceLineItems`, `payments`, `expenses`, `recurringInvoices`, `scopeSettings`.

### B1.3 Tests

`convex-test` + `vitest` + `@edge-runtime/vm`, with the negative cases as the point: org A's user cannot read org B's row by id; a viewer's write is refused; personal scope cannot see org rows. Two further tests exist specifically because of the `convex-helpers` layer — one that deliberately writes a query *without* its `scopeId` filter and asserts row-level security returns nothing anyway, and one that writes a document directly and asserts the audit row and counter both moved without the mutation calling anything.

**Acceptance:** `npx convex dev` deploys the schema clean; isolation tests pass; the observed identity shape is documented in the PR.

---

## Phase B2 — Clerk → Convex sync (webhooks)

**Branch:** `feat/b2-clerk-sync`

`convex/http.ts` exposing `POST /clerk-webhook`, verified with the raw `svix` `Webhook` class against `CLERK_WEBHOOK_SECRET` — set in the **Convex** dashboard env, not Vercel's. The endpoint URL uses the deployment's **`.site`** domain (`NEXT_PUBLIC_CONVEX_SITE_URL`), not `.cloud`.

Handled events, each dispatching to an `internalMutation`:

- `user.created` / `.updated` / `.deleted`
- `organization.created` / `.updated` / `.deleted`
- `organizationMembership.created` / `.updated` / `.deleted`
- `subscription.created` / `.updated` / `.active` / `.pastDue`
- `subscriptionItem.created` / `.active` / `.updated` / `.canceled` / `.ended`

Payload shape traps to handle explicitly: the payer is nested at `data.payer.{user_id, organization_id}` — **not** a top-level `org_id`; the plan slug is at `data.items[i].plan.slug`; `subscriptionItem.*` events carry no back-reference to their subscription, so they are matched by item id or by `(payer, plan)`. Handlers are idempotent — webhooks are at-least-once.

Also: create `scopeSettings` and seed the expense categories on first `organization.created` / `user.created`.

**Acceptance:** creating an org in Clerk produces rows in `organizations` + `memberships` + `scopeSettings` within seconds; replaying the same event changes nothing.

---

## Phase B3 — Clerk Dashboard configuration (guided, no code)

**Branch:** `docs/b3-clerk-config` (adds `docs/clerk-setup.md` only)

> **Status: mostly done (2026-09-22).** Was skipped on 2026-09-21 so B4 onward could proceed against a stubbed config; resumed once B4–B9 were merged. `docs/clerk-setup.md` documents what's configured, a real bug found and fixed (`free_org`/`business_org` had the wrong Features attached), and reads every value back through the Backend API where the API exposes it. Three items turned out to be genuinely Dashboard-only on this account — not yet automatable, confirmed by real `404`s from Clerk's own API edge, not a guess: creating the `org:accountant` / `org:viewer` roles, setting the three org plans' seat caps, and confirming one live webhook delivery. See the checklist in `docs/clerk-setup.md`.

You do every click here yourself; I supply exact values and verify the result afterwards through the Clerk Backend API. **Every description below is final copy — paste it verbatim.** All are under 500 characters, which is our house limit for readability; Clerk does not publish a limit for these fields, so if one truncates, tell me and I will trim.

### The model you have to understand first

Clerk ties three concepts together, and getting this wrong is what made my earlier draft incoherent:

```
Permission  =  org : <feature> : <action>
                     ^^^^^^^^^
                     must be a real Feature slug
```

A **Feature** is a named capability. A **Permission** lives *inside* a feature — the middle segment of `org:invoices:manage` is the `invoices` feature. A **Plan** attaches features. And then the rule that binds them:

> `has({ permission: 'org:invoices:manage' })` returns `true` only if the role carries that permission **and** the active plan includes the `invoices` feature.

This is why the earlier version was broken: it invented permissions like `org:settings:manage` while the only features were `recurring_invoices`, `reports`, `ai_receipt_scanning`, and `multi_currency`. There was no `settings` feature, so that permission could never evaluate true.

Handled deliberately, the coupling stops being a trap and becomes the design. Split features into two groups:

- **Core features** — attached to *every* plan including Free. Their permissions are pure role-based access control: `invoices`, `expenses`, `clients`, `settings`, `audit`.
- **Premium features** — attached only to paid plans. Their permissions are gated by role *and* by tier, in one expression: `reports`, `recurring_invoices`, `receipt_scanning`, `multi_currency`.

So `has({ permission: 'org:reports:read' })` is automatically `false` for everyone on Free, because Free does not carry the `reports` feature — no separate plan check needed.

### Why the sections run in this order

Features are created **inside a plan's edit page**, not on a global Features page. Permissions cannot be created until their feature slug exists. Roles cannot be given permissions that do not exist. And the Creator Role setting cannot point at Owner until Owner exists. So the working order is:

**organizations on → billing on → plans and features → permissions → roles → back to org settings for the role defaults.**

---

### B3.0 Before you start

Open [dashboard.clerk.com](https://dashboard.clerk.com) and confirm:

1. **The right instance.** The switcher at the top of the sidebar reads **Development**. None of this copies to Production later — promoting means redoing this phase by hand. That is a Clerk limitation, not an oversight here.
2. **Your keys match.** `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in `.env.local` starts with `pk_test_`.
3. **You can reach the Convex dashboard too.** Needed in B3.8 for the webhook secret, which is a Convex environment variable, not a `.env.local` one.

---

### B3.1 Enable Organizations

**Navigate:** Configure → **Organization Settings**

| Setting | Value | Why |
|---|---|---|
| Enable organizations | **On** | Nothing else appears until this is on. |
| **Membership** | **`Membership optional`** | The single most important setting in this phase. |
| Allow users to create organizations | **On** | Users self-serve their first workspace. |
| Maximum allowed memberships | Leave default | The real cap comes from the plan's seat limit in B3.3. Setting it here too would override the plan. |
| Verified domains | Off | Useful later for auto-join by email domain; out of scope. |
| Creator role / Default role | **Come back in B3.6** | The roles do not exist yet. |

**On `Membership optional`:** since 2025-08-22 Clerk defaults new instances to **Membership required**, which forces every signed-in user through a `choose-organization` task and **disables personal accounts entirely**. Leave that default and the personal-scope half of CashView silently cannot exist — `<OrganizationSwitcher hidePersonal={false} />` will not offer a Personal Account entry whatever props we pass. Afterwards, verify by signing in as a user with no organizations: you should land in the app, not on an org-selection screen.

---

### B3.2 Enable Billing

**Navigate:** Configure → **Billing** → Settings

1. Click **Enable Billing**.
2. Choose the **Clerk development gateway**. On Development this needs **no Stripe account** and supports real checkouts with test cards. Production would require connecting your own Stripe account here.
3. Clerk auto-creates two starter plans, `free_user` and `free_org`. Keep both — B3.3 repurposes them rather than creating duplicates.

Test card: `4242 4242 4242 4242`, any future expiry, any CVC.

---

### B3.3 Plans and Features

**Navigate:** Configure → Billing → **Plans**

Features are created and attached **inside each plan's edit page** (open a plan → Features → add). There is no global Features page. The first plan you edit is where each feature slug is born; every later plan reuses the same slug.

#### The nine features

Create these as you build the plans. **The slug is the exact string Convex stores and the exact middle segment of every permission in B3.4**, so it must match character for character.

| Slug | Group | Free | Pro | Business |
|---|---|:---:|:---:|:---:|
| `invoices` | core | ✓ | ✓ | ✓ |
| `expenses` | core | ✓ | ✓ | ✓ |
| `clients` | core | ✓ | ✓ | ✓ |
| `settings` | core | ✓ | ✓ | ✓ |
| `audit` | core | ✓ | ✓ | ✓ |
| `reports` | premium | — | ✓ | ✓ |
| `recurring_invoices` | premium | — | ✓ | ✓ |
| `receipt_scanning` | premium | — | — | ✓ |
| `multi_currency` | premium | — | — | ✓ |

The five core features go on **every** plan. That is not padding — omit `invoices` from Free and `org:invoices:manage` returns `false` for a Free Owner, and the product simply stops working.

**`invoices` — Invoices**

> Create and manage invoices: line items with quantities, unit prices and per-line tax, invoice-level discounts, issue and due dates, template choice, draft and send states, public share links your clients open without signing in, payment recording including partial payments, and voiding. Present on every plan, including Free, where a monthly invoice cap applies instead. The permissions inside this feature decide who may write rather than only read.

**`expenses` — Expenses**

> Log and manage business expenses: vendor, amount, tax component, date and payment method, with receipt images stored against your workspace and reachable from nowhere else. Includes custom expense categories, marking an expense billable against a client, and editing or deleting past entries. Present on every plan including Free, with no cap on how many expenses you log. Automatic receipt reading is a separate feature.

**`clients` — Clients**

> Maintain the client directory: contact name, company, email, phone and billing address, per-client invoicing currency, internal notes that never appear on an invoice, archiving that hides a client from pickers while preserving their history, and per-client invoice history with outstanding balance. Present on every plan, including Free, where a cap on total clients applies instead.

**`settings` — Organization settings**

> Control what appears on every document the workspace issues: legal business name, registered address, contact email and phone, tax identification number, invoice branding including logo, accent colour and template, base currency, default tax rate, invoice number prefix and next sequence, default payment terms, and the standing invoice footer. Present on every plan; the permission inside it decides who may change these rather than only read them.

**`audit` — Audit trail**

> The append-only record of activity in this workspace: every create, edit, delete, status change, payment, send and settings change, showing who did it, what changed from what to what, and when. This is what answers "who voided this invoice" or "when did this address change". Present on every plan so the record is always kept; the permission inside it decides who may read it.

**`reports` — Financial reports**

> The full reporting suite: revenue by month, quarter and year; a profit and loss summary setting invoiced revenue against logged expenses; cash flow showing money received against money spent; outstanding versus collected, separating what was billed from what landed; and expense breakdown by category. Every figure is computed from your own records and can be exported. Without it the dashboard still shows live balances, but historical views are locked.

**`recurring_invoices` — Recurring invoices**

> Turn an invoice into a schedule that issues itself — weekly, monthly, quarterly or yearly, with a start date and an optional end. CashView generates each new invoice on the due day, carrying forward line items, tax rates and payment terms. Generated invoices arrive as drafts so you can review before sending, schedules pause and resume at any time, and numbering continues in the same sequence. Built for retainers and subscriptions.

**`receipt_scanning` — AI receipt scanning**

> Photograph or upload a receipt and CashView reads it for you. Vendor, date, total, tax and the likely category are extracted and presented as a pre-filled expense you review, correct and confirm — nothing saves without your approval. Handles phone photos, scans and PDF receipts, including crumpled or badly lit ones. Takes most of the typing out of expense logging, which is where expense tracking usually breaks down.

**`multi_currency` — Multi-currency invoicing**

> Invoice each client in their own currency while your books stay in one base currency. Set a currency per client and every invoice against them is issued, shown and exported in it, with the exchange rate captured at issue time so historical invoices never silently change value. Reports and dashboard totals stay in your base currency, converted at each invoice's recorded rate, so revenue across currencies stays comparable.

> **Note the rename:** the feature formerly called `ai_receipt_scanning` is now **`receipt_scanning`**, so that its permission reads `org:receipt_scanning:use` rather than the clumsier `org:ai_receipt_scanning:use`. Convex's `PLAN_LIMITS` in B4 uses the new slug.

#### Organization Plans

**Navigate:** Configure → Billing → Plans → **Organization Plans** tab

Subscriptions paid by an organization and shared by everyone in it. A plan's type is fixed at creation — build one in the wrong tab and you must delete it and start over, so check the tab heading each time.

| Slug | Name | Price | Seats | Features |
|---|---|---|---|---|
| `free_org` *(exists — edit)* | Free | $0 | 1 | the 5 core |
| `pro_org` *(create)* | Pro | $19/mo · $190/yr | 5 | core + `reports`, `recurring_invoices` |
| `business_org` *(create)* | Business | $49/mo · $490/yr | 20 | all nine |

**`free_org`:**

> Everything you need to send your first invoices, free and with no card. Up to 5 clients and 10 invoices per calendar month, unlimited expense logging with receipt uploads, PDF invoices, public share links your clients open without signing in, and a live dashboard of what you're owed and what you've collected. Single user. Reports, recurring invoices, receipt scanning and multi-currency are not included. Caps stop you adding more; they never lock you out of what you have.

**`pro_org`:**

> For a business that has outgrown spreadsheets. Removes every Free cap — unlimited clients, unlimited invoices — and adds up to 5 team members with their own logins and roles, so your bookkeeper and your accountant work in the same books without sharing a password. Adds recurring invoices for retainers, and the full reporting suite: revenue trends, profit and loss, cash flow and expense breakdown. Includes everything in Free. Annual works out at two months free.

**`business_org`:**

> For established teams billing across borders and processing expenses at volume. Everything in Pro, a team limit of 20, and the two features that save the most time at scale: AI receipt scanning, which reads vendor, date, total, tax and category straight off a photo so expense logging stops being data entry; and multi-currency invoicing, so you bill each client in their currency while reports stay in one base currency. Billed to the organization, shared by every member.

#### User Plans (personal scope)

**Navigate:** Configure → Billing → Plans → **User Plans** tab

Subscriptions paid by an individual, applying only to their personal workspace. Not optional extras: a freelancer who never creates an organization lives entirely in personal scope, and without these could never upgrade — or pay you. Same features, priced lower because there is only ever one user. Seats do not apply.

| Slug | Name | Price | Features |
|---|---|---|---|
| `free_user` *(exists — edit)* | Free | $0 | the 5 core |
| `pro_user` *(create)* | Pro | $9/mo · $90/yr | core + `reports`, `recurring_invoices` |
| `business_user` *(create)* | Business | $24/mo · $240/yr | all nine |

**`free_user`:**

> Start invoicing today, no card. Your personal workspace gets up to 5 clients, 10 invoices per calendar month, unlimited expense logging with receipt uploads, PDF invoices, and public share links your clients open without signing in. Ideal for a freelancer or side business trying CashView before paying for anything. Reports, recurring invoices, receipt scanning and multi-currency are not included. Your personal books stay separate from any organization you join.

**`pro_user`:**

> For the independent professional whose invoicing has become real work. Removes the client and monthly invoice caps, adds recurring invoices so retainer clients bill themselves on schedule, and unlocks the full reporting suite — revenue trends, profit and loss, cash flow and expense breakdown — which is what turns a pile of invoices into something you can hand an accountant at year end. Applies to your personal workspace only.

**`business_user`:**

> For the established independent consultant working across currencies and expensing at volume. Everything in Pro, plus AI receipt scanning, which reads vendor, date, total, tax and category straight off a photographed receipt so logging takes seconds; and multi-currency invoicing, so you bill international clients in their own currency while your reports stay in one base currency at each invoice's recorded rate. Personal workspace only.

#### Seats — read before setting the numbers

- **Clerk enforces the cap itself**, at invite and join time. The application needs no blocking logic and builds none. The UI still *displays* the limit and its usage, because an invite that fails silently is a bad experience.
- **Price does not scale with members.** A seat-limited plan is a fixed price with a ceiling, not per-seat billing. A fourth member on Pro does not change the bill; a sixth is refused until the org upgrades.
- **Caps above 20, or unlimited, require Clerk's paid B2B Authentication add-on.** Hence Business is 20 on this Development instance. Without the add-on Clerk's 20 is the number that binds, so the UI reads the value off the plan rather than printing "unlimited". B4's `PLAN_LIMITS` records `orgSeats: 20` for the same reason.

---

### B3.4 Permissions, grouped by feature

**Navigate:** Configure → Organization Settings → **Roles & Permissions** → Permissions

Now that the feature slugs exist, the permissions inside them can be created. Each key is `org:<feature>:<action>` and **the feature segment must match a slug from B3.3 exactly**.

#### System permissions — where Owner and Admin diverge

Nine permissions are built into Clerk. Use them verbatim; do not invent shorter forms. The two bold rows are the entire Owner/Admin distinction.

| System permission | Controls | Owner | Admin | Accountant | Viewer |
|---|---|:---:|:---:|:---:|:---:|
| `org:sys_profile:manage` | Edit org name, slug, logo | ✓ | ✓ | — | — |
| **`org:sys_profile:delete`** | **Delete the organization** | **✓** | **—** | — | — |
| `org:sys_memberships:read` | View the member list | ✓ | ✓ | ✓ | ✓ |
| `org:sys_memberships:manage` | Invite, remove, re-role members | ✓ | ✓ | — | — |
| `org:sys_domains:read` | View verified domains | ✓ | ✓ | — | — |
| `org:sys_domains:manage` | Add, verify, remove domains | ✓ | — | — | — |
| `org:sys_billing:read` | View subscription and invoices | ✓ | ✓ | — | — |
| **`org:sys_billing:manage`** | **Change plan and payment method** | **✓** | **—** | — | — |
| `org:sys_entconns:manage` | Manage self-serve SSO connections | ✓ | — | — | — |

Admin keeps `org:sys_billing:read` deliberately: an Admin who cannot see which plan the organization is on has no way to understand why a feature is locked, and will just ask the Owner. Seeing the plan is not controlling it.

**You will need to edit the built-in `org:admin` role to remove `org:sys_profile:delete`, `org:sys_domains:manage`, `org:sys_billing:manage` and `org:sys_entconns:manage`.** Clerk only documents a block on *deleting* a default role set as Creator or Default, and B3.6 moves Creator to Owner, so `org:admin` should be unpinned and editable.

**Flagging honestly: Clerk's docs do not confirm either way that a built-in role's system permissions can be edited.** This is the one step in B3 I cannot promise will work. Try it; if the dashboard refuses any of those four toggles, stop and tell me. The fallback costs nothing — leave `org:admin` untouched, never assign it, and create a custom role `org:manager` named **Admin** carrying exactly the permissions in the matrix. Convex maps `admin` and `manager` onto the same capability set, so no backend change either way.

#### Custom permissions

Thirteen, grouped under the feature each belongs to. Convex does **not** read these (architecture decision A3) — it reads the role slug and applies its own matrix. They exist so the Next.js layer can call `has({ permission })` for UI gating and so the roles read correctly in the dashboard.

##### Feature `invoices`

| Key | Name | Owner | Admin | Accountant | Viewer |
|---|---|:---:|:---:|:---:|:---:|
| `org:invoices:read` | View invoices | ✓ | ✓ | ✓ | ✓ |
| `org:invoices:manage` | Manage invoices | ✓ | ✓ | ✓ | — |

> **View invoices.** Open any invoice and read its line items, quantities, unit prices, tax breakdown, discounts, issue and due dates, current status, payment history and public share link. Also covers the invoice list with its filters and the per-client invoice history. Read-only: holders can see every figure but cannot change, send, void or delete anything, and cannot record a payment.

> **Manage invoices.** Create invoices; edit drafts; add and remove line items and set quantities, unit prices, per-line tax and discounts; choose template, issue date and due date; mark an invoice sent and mint its public share link; record and reverse full or partial payments; void an issued invoice while keeping it on record; and delete a draft that was never sent. Every write in the invoicing surface is refused without this.

##### Feature `expenses`

| Key | Name | Owner | Admin | Accountant | Viewer |
|---|---|:---:|:---:|:---:|:---:|
| `org:expenses:read` | View expenses | ✓ | ✓ | ✓ | ✓ |
| `org:expenses:manage` | Manage expenses | ✓ | ✓ | ✓ | — |

> **View expenses.** Browse logged expenses with their vendor, amount, tax component, date, payment method and category; open attached receipt images; and see which expenses are marked billable against a client. Read-only: holders cannot log, edit or delete an expense, cannot upload or replace a receipt, and cannot change categories.

> **Manage expenses.** Log expenses with vendor, amount, tax, date and payment method; attach, replace and remove receipt images in the workspace's scoped storage; create, rename, recolour and delete expense categories; mark an expense billable against a client; and edit or delete past entries. Receipts stored here are unreachable from any other organization or personal account, including by direct URL.

##### Feature `clients`

| Key | Name | Owner | Admin | Accountant | Viewer |
|---|---|:---:|:---:|:---:|:---:|
| `org:clients:read` | View clients | ✓ | ✓ | ✓ | ✓ |
| `org:clients:manage` | Manage clients | ✓ | ✓ | ✓ | — |

> **View clients.** Browse the client directory and open any client to see their contact name, company, email, phone, billing address, invoicing currency, full invoice history and current outstanding balance. Includes archived clients. Read-only: holders cannot add, edit, archive or delete a client, and cannot see internal notes marked private.

> **Manage clients.** Add clients with contact name, company, email, phone and billing address; edit those details; set a client's invoicing currency, which drives invoice currency where multi-currency is available; attach internal notes never shown on an invoice; archive a client so they leave the pickers while their history survives; restore from archive; and delete a client with no invoices. Deleting one with invoice history is refused so the books stay consistent.

##### Feature `settings`

| Key | Name | Owner | Admin | Accountant | Viewer |
|---|---|:---:|:---:|:---:|:---:|
| `org:settings:read` | View settings | ✓ | ✓ | ✓ | ✓ |
| `org:settings:manage` | Manage settings | ✓ | ✓ | — | — |

> **View settings.** See the workspace's business name, registered address, contact details, tax identification number, invoice branding, base currency, default tax rate, invoice numbering and payment terms. Useful for an accountant who needs to know the configured tax rate or numbering scheme without being able to alter it. Read-only in every respect.

> **Manage settings.** Edit what appears on every document the workspace issues: legal business name, registered address, contact email and phone, tax identification number, invoice branding including logo, accent colour and template, base currency, default tax rate, invoice number prefix and next sequence, default payment terms driving due dates, and the standing invoice footer. These apply to already-drafted invoices as well as new ones.

##### Feature `audit`

| Key | Name | Owner | Admin | Accountant | Viewer |
|---|---|:---:|:---:|:---:|:---:|
| `org:audit:read` | View audit trail | ✓ | ✓ | — | — |

> **View audit trail.** Read the append-only record of every create, edit, delete, status change, payment, send and settings change in this workspace, showing who did it, what changed from what to what, and when. This is what answers "who voided this invoice" or "when did this address change". Granting it beyond Owners and Admins is reasonable for an external auditor, but it exposes every member's activity to whoever holds it.

##### Feature `reports` *(premium — Pro and Business only)*

| Key | Name | Owner | Admin | Accountant | Viewer |
|---|---|:---:|:---:|:---:|:---:|
| `org:reports:read` | View financial reports | ✓ | ✓ | ✓ | ✓ |

> **View financial reports.** Open the reporting section: revenue by month, quarter and year; outstanding versus collected; the profit and loss summary setting invoiced revenue against logged expenses; expense breakdown by category; and the cash-flow view of money in against money out. Includes exporting the underlying figures. Returns false for everyone on Free, because Free does not carry the reports feature.

##### Feature `recurring_invoices` *(premium — Pro and Business only)*

| Key | Name | Owner | Admin | Accountant | Viewer |
|---|---|:---:|:---:|:---:|:---:|
| `org:recurring_invoices:manage` | Manage recurring invoices | ✓ | ✓ | ✓ | — |

> **Manage recurring invoices.** Create schedules that issue invoices automatically — weekly, monthly, quarterly or yearly — with a start date, an optional end date, and the line items, tax rates and payment terms that each generated invoice carries. Pause, resume, edit and delete schedules, and see which invoices a schedule produced. Returns false on Free, which does not carry the recurring invoices feature.

##### Feature `receipt_scanning` *(premium — Business only)*

| Key | Name | Owner | Admin | Accountant | Viewer |
|---|---|:---:|:---:|:---:|:---:|
| `org:receipt_scanning:use` | Use AI receipt scanning | ✓ | ✓ | ✓ | — |

> **Use AI receipt scanning.** Run an uploaded or photographed receipt through automatic extraction, which reads the vendor, date, total, tax component and likely category and returns them as a pre-filled expense to review, correct and confirm. Nothing is saved without confirmation. Returns false on Free and Pro, which do not carry the receipt scanning feature.

##### Feature `multi_currency` *(premium — Business only)*

| Key | Name | Owner | Admin | Accountant | Viewer |
|---|---|:---:|:---:|:---:|:---:|
| `org:multi_currency:use` | Use multi-currency | ✓ | ✓ | ✓ | — |

> **Use multi-currency.** Set an invoicing currency per client and issue invoices in it, with the exchange rate captured at issue time so historical invoices never silently change value, while reports and dashboard totals stay in the workspace's base currency. Returns false on Free and Pro, which do not carry the multi-currency feature.

---

### B3.5 Roles

**Navigate:** Configure → Organization Settings → **Roles & Permissions** → Roles

Four roles. Owner and Admin are genuinely different: an Admin *runs* the organization, an Owner *owns* it. The line is money and existence, and Clerk makes it real through `org:sys_billing:manage` and `org:sys_profile:delete`. That is why we do not reuse `org:admin` for Owner — we create a real `org:owner` and leave `org:admin` meaning what its key has always meant.

Assign each role the permissions marked for it in every table in B3.4.

#### Owner — `org:owner` *(create)*

> Ultimate authority over the organization. Everything an Admin can do, plus the three things that are irreversible or cost money: choosing and changing the subscription plan, updating the payment method, and reading billing history; transferring ownership to another member; and deleting the organization outright. Assign only to people accountable for the money. An organization always keeps at least one Owner.

#### Admin — `org:admin` *(built-in — keep the key and the name, replace the description)*

> Runs the organization day to day without controlling the money. Everything an Accountant can do, plus: invite, remove and re-role members; edit company details, tax ID, invoice branding, currency, tax rates and numbering; and read the full audit trail. Can see which plan the organization is on, but cannot change the plan, the payment method or billing history, cannot transfer ownership, and cannot delete the organization.

#### Accountant — `org:accountant` *(create)*

> Full bookkeeping, no administration. Create, edit, send, void and delete invoices; record and reverse payments; add, edit and archive clients; log expenses, upload receipts and run receipt scanning; manage recurring schedules; and read every report. Cannot manage members, change settings or branding, see billing, or read the audit trail. The right default for in-house finance staff and external accountants.

#### Viewer — `org:viewer` *(create)*

> Read-only access to the books. Open invoices with their line items and payment history, browse clients and outstanding balances, view expenses and receipts, and read every report and dashboard chart. Every write is refused by the server, not merely hidden in the interface. Cannot record payments, upload anything, change settings, manage members, see billing, or read the audit trail. For investors, advisors and auditors.

#### On `org:member`

Built in and undeletable. CashView does not use it. Convex maps it — and any unrecognised role — to **Viewer**, so an unexpected role fails closed. Leave it and never assign it.

Three custom roles against Clerk's limit of **10 per instance**.

---

### B3.6 Return to Organization Settings for the role defaults

**Navigate:** Configure → **Organization Settings**

Now that the roles exist:

| Setting | Value |
|---|---|
| **Creator role** | **Owner** — open the role's three-dot menu → **"Set as creator role."** |
| **Default role** for invitees | **Accountant** — three-dot menu → **"Set as default role."** |

Clerk requires the creator role to carry at minimum `org:sys_memberships:manage`, `org:sys_memberships:read` and `org:sys_profile:delete`. Owner holds all nine system permissions, so it qualifies. Clerk's docs explicitly support reassigning the creator role to any qualifying role, precisely so teams are not stuck with `org:admin`.

Setting Creator to Owner is also what unpins `org:admin` and makes B3.4's permission edits possible. If you did B3.4 first and the toggles were locked, come back and retry them now.

**Verify:** create a throwaway organization from the app. You should be its **Owner**, not its Admin.

#### One honest limitation

Clerk's membership management is all-or-nothing. Any role holding `org:sys_memberships:manage` can re-role or remove **anyone**, including an Owner — Clerk has no "cannot modify a higher role" concept. So through `<OrganizationProfile />`, an Admin can demote an Owner.

Two options, your call at Phase F7:

1. **Accept it.** Admin is a trusted role and the audit trail records the change. Simplest, fine for most teams.
2. **Close it.** Replace the members tab with a custom UI backed by a Convex action calling the Clerk Backend API, refusing any change targeting an Owner unless the caller is an Owner. Roughly a day in F7.

I have planned for option 1 and will raise it again when F7 starts.

---

### B3.7 How organization plans, members, and personal plans fit together

This is the part that is easy to get wrong, so it is worth stating explicitly.

**A subscription belongs to a payer, and a payer is either one organization or one user.** There is no such thing as a per-member plan inside an organization. When an organization subscribes to `pro_org`, that single subscription covers the organization, and **every member of it inherits the same entitlements regardless of their role**. An Accountant in a Business organization gets AI receipt scanning; a Viewer in a Free organization does not get reports. Role governs *what you may do*; plan governs *what the workspace can do*. They are independent axes and both are checked on every request.

**A member's personal subscription never leaks into an organization, and vice versa.** If you personally pay for `business_user` and you are also a member of an organization on `free_org`, then:

- working in **Personal account** scope, you have AI receipt scanning and unlimited invoices;
- switching to that **organization** in the switcher, you are on Free — 5 clients, 10 invoices a month, no scanning.

Nothing about your personal plan upgrades the organization. This is correct and intentional: the organization's books belong to the organization, and its Owner decides what the organization pays for.

**Which entitlement applies is decided entirely by the active scope.** Convex derives the scope from the JWT — the organization id when an organization is active, the user id otherwise — then looks up the `subscriptions` row for exactly that `scopeId`. There is no merging, no falling back from org plan to personal plan, and no "best of both".

**A single user with their own organization is a normal, supported case.** Someone who creates an organization purely for themselves ends up with two independent workspaces: their personal one and their one-person organization. They may pay for both, one, or neither. This is precisely why the user plans in B3.7 are not optional — without them that person's personal workspace could never be upgraded, and without org plans their one-person organization could never be upgraded either.

**Quota counters are per scope too.** The Free plan's "10 invoices per calendar month" is counted separately for your personal workspace and for each organization you belong to. Hitting the cap in one has no effect on the others.

---

### B3.8 Webhooks — Clerk → Convex

Everything in `subscriptions`, `users`, `organizations`, and `memberships` arrives through this endpoint. If it is not configured, the application will authenticate perfectly well and then behave as though every scope is on Free forever, because `getEntitlements` defaults to Free when no synced subscription row exists. **This is the step most likely to be skipped and most likely to cost an afternoon.**

#### Step 1 — Find your Convex HTTP Actions URL

The webhook target is the **`.site`** domain, not the `.cloud` one used for queries. It is already in `.env.local`:

```bash
grep NEXT_PUBLIC_CONVEX_SITE_URL .env.local
```

Your endpoint is that value with `/clerk-webhook` appended, e.g. `https://fantastic-lizard-123.convex.site/clerk-webhook`.

A genuinely useful property of this setup: **Convex HTTP actions are cloud-hosted even during local development.** Clerk can reach your dev deployment directly, so there is no ngrok, no tunnel, and no webhook forwarding to run alongside `pnpm dev`. This is the main reason the webhook lives in Convex rather than in a Next.js route handler.

#### Step 2 — Create the endpoint

**Navigate:** Configure → **Webhooks** → Add Endpoint

- **Endpoint URL:** the `.site` URL from step 1
- **Description:** `Sync Clerk users, organizations, memberships, and billing subscriptions into Convex`
- **Subscribe to events:** tick exactly these fourteen —

| Event | What CashView does with it |
|---|---|
| `user.created` | Insert the `users` row, create their personal `scopeSettings`, seed their personal expense categories |
| `user.updated` | Refresh name, email, avatar |
| `user.deleted` | Mark the user row deleted; personal-scope data is retained for audit |
| `organization.created` | Insert `organizations`, create org `scopeSettings`, seed org expense categories |
| `organization.updated` | Refresh name, slug, logo |
| `organization.deleted` | Mark the organization deleted |
| `organizationMembership.created` | Insert `memberships` — drives the team roster and seat display |
| `organizationMembership.updated` | Update the stored role when someone is re-roled |
| `organizationMembership.deleted` | Remove the membership row |
| `subscription.created` | Insert the `subscriptions` row for that payer |
| `subscription.updated` | Update plan, status, period dates |
| `subscription.active` | Mark active — this is the event that actually unlocks a paid tier |
| `subscription.pastDue` | Mark past due; the app keeps read access and blocks new paid-feature use |
| `subscriptionItem.canceled` / `.ended` | Downgrade the scope back to Free |

Do **not** tick "receive all events" — session and token events fire constantly and make the Clerk webhook log useless for debugging.

#### Step 3 — Copy the signing secret into Convex

On the endpoint's page, reveal **Signing Secret** (it starts `whsec_`). Set it as a **Convex** environment variable — not in `.env.local`, because the handler runs on Convex:

```bash
npx convex env set CLERK_WEBHOOK_SECRET whsec_your_secret_here
```

Verify it landed:

```bash
npx convex env list
```

#### Step 4 — Verify end to end

After Phase B2's handler is deployed:

1. In Clerk's webhook page, use **Send test event** with `user.created`. It should return **200**.
2. Run `npx convex logs` and confirm the handler logged the event.
3. Do the real thing: create an organization in the app, then check the Convex data browser for new rows in `organizations`, `memberships`, and `scopeSettings`.
4. Re-send the same test event. Nothing should change — the handlers are idempotent because Clerk delivers at least once, and duplicate delivery is routine rather than exceptional.

If step 1 returns **401** the secret is wrong or unset. If it returns **404** you are pointing at `.cloud` instead of `.site`.

#### Payload shapes that differ from what you would guess

Each of these has cost somebody a debugging session:

- The payer on a billing event is at **`data.payer.organization_id`** or **`data.payer.user_id`** — there is *no* top-level `org_id` on billing events. Which of the two is populated is how the handler decides `scopeKind`.
- The plan slug is at **`data.items[i].plan.slug`**, not `data.plan`.
- **`subscriptionItem.*` events carry no back-reference to their parent subscription.** They are matched by item id, or failing that by `(payer, plan)`.
- Clerk's billing event names are **not** Stripe's. There is no `subscription.canceled`; cancellation arrives as `subscriptionItem.canceled`.

---

### B3.9 Confirm the session token carries the organization claim

**Navigate:** Configure → **Sessions** → Customize session token

You should not need to change anything — Clerk includes the compact `o` claim (`{ id, rol, per, slg, fpm }`) by default whenever an organization is active. Open the claims editor and confirm it has not been customised in a way that removes it. If it is untouched, leave it alone.

Do **not** add `{{org.id}}` / `{{org.role}}` as custom top-level claims. That duplicates data already present under `o` under different names, and it is how a codebase ends up with two sources of truth for the caller's organization. Phase B1.0's probe reads whatever is actually in the token and `requireScope()` is written against that.

---

### B3.10 Verification checklist

Tick these off before opening the B3 PR. I will independently read the configuration back through the Clerk Backend API and include the diff in the PR description.

- [ ] Organizations enabled, membership mode reads **optional**
- [ ] Signing in as a user with zero organizations lands in the app, not on an org-selection screen
- [ ] Billing enabled on the Clerk development gateway
- [ ] **Nine features exist**, spelled exactly: `invoices`, `expenses`, `clients`, `settings`, `audit`, `reports`, `recurring_invoices`, `receipt_scanning`, `multi_currency`
- [ ] **The five core features are attached to every plan, Free included** — this is the one that breaks the product if missed
- [ ] Three **organization** plans: `free_org`, `pro_org`, `business_org`, seats 1 / 5 / 20, features per the B3.3 grid
- [ ] Three **user** plans: `free_user`, `pro_user`, `business_user`, features per the B3.3 grid
- [ ] **Thirteen custom permissions exist**, every one's middle segment matching a feature slug from B3.3
- [ ] Four roles exist: `org:owner` (created), `org:admin` (kept as Admin), `org:accountant`, `org:viewer`, each with its description pasted and its permissions assigned
- [ ] `org:admin` no longer holds `org:sys_profile:delete`, `org:sys_domains:manage`, `org:sys_billing:manage`, or `org:sys_entconns:manage` — **or**, if the dashboard refused, the `org:manager` fallback from B3.4 is in place instead
- [ ] **Owner is set as the Creator Role** — create a throwaway org and confirm you are its Owner, not its Admin
- [ ] Default role for invitees is Accountant
- [ ] Signed in as an Admin, check `<OrganizationProfile />`: Clerk's docs do not say whether removing `org:sys_billing:manage` *hides* the billing controls or merely disables them, so note which you observe. If only disabled, F7 renders its own billing tab gated on the capability instead of relying on Clerk's component.
- [ ] Spot-check the coupling: as a Free Owner, `has({ permission: 'org:reports:read' })` is `false`; as a Pro Owner it is `true`. If it is false on Pro, the `reports` feature is not attached to `pro_org`.
- [ ] Webhook endpoint points at the **`.site`** domain and is subscribed to all fourteen events
- [ ] `CLERK_WEBHOOK_SECRET` set in **Convex** env and confirmed by `npx convex env list`
- [ ] A test event returns 200 and appears in `npx convex logs`

**Acceptance:** the Backend API read-back matches every table in this section, and a real organization created through the UI produces its `organizations`, `memberships`, `scopeSettings`, and `subscriptions` rows in Convex within a few seconds.

---

## Phase B4 — Entitlements, quotas, and audit

**Branch:** `feat/b4-entitlements-quotas`

`convex/lib/entitlements.ts` holding the single source of truth:

```ts
// The five core features ride on every plan, Free included. They exist so Clerk permissions
// like `org:invoices:manage` resolve at all — a permission whose feature is missing from the
// plan always reads false. See B3.3.
const CORE = ["invoices", "expenses", "clients", "settings", "audit"] as const;

// Keyed by planKey, which the webhook derives from the Clerk plan slug:
//   free_org | free_user -> "free"   pro_org | pro_user -> "pro"   business_org | business_user -> "business"
// The same limits apply whether the payer is an organization or a user; only `seats` differs,
// and in personal scope seats is always 1 because a personal workspace has exactly one member.
const PLAN_LIMITS = {
  free:     { clients: 5,        invoicesPerMonth: 10,       orgSeats: 1,  features: [...CORE] },
  pro:      { clients: Infinity, invoicesPerMonth: Infinity, orgSeats: 5,  features: [...CORE, "reports", "recurring_invoices"] },
  // orgSeats 20, not Infinity: Clerk caps seats at 20 without the paid B2B Authentication
  // add-on (see B3.6), so Clerk's number is the one that actually binds. The UI reads this
  // value rather than printing the word "unlimited".
  business: { clients: Infinity, invoicesPerMonth: Infinity, orgSeats: 20, features: [...CORE, "reports", "recurring_invoices", "receipt_scanning", "multi_currency"] },
} as const;
```

Note what this table deliberately does *not* encode: it is keyed by tier, not by payer type, because the entitlements are identical either way. The webhook normalises `pro_org` and `pro_user` to the same `planKey`, so every gate downstream asks "what can this scope do", never "is this an organization". That keeps personal scope a first-class workspace rather than a degraded special case.

- `getEntitlements(ctx, scope)` — reads `subscriptions`, defaults to `free` when absent (a scope with no synced subscription must never fall open).
- `requireFeature(ctx, scope, "recurring_invoices")` — throws a typed `ConvexError({ code: "UPGRADE_REQUIRED", feature, currentPlan })` the UI turns into an upgrade prompt rather than a generic error toast.
- `assertQuota(ctx, scope, "invoices")` — reads the `usageCounters` row and refuses before the write. The *increment* side is not called here at all: the triggers registered in B1.2 own it, so a new write path cannot forget to count itself.

A public `getUsageSummary` query backs the UI's "7 of 10 invoices used this month" meters.

The audit trail is finished here too — the B1.2 triggers already fire on every audited table, so this phase writes the field-level differ they call, maps each table and operation onto a human-readable summary line, and adds the `listAuditLog` query gated on the `audit.read` capability. Nothing is hand-called from inside a mutation.

**Acceptance:** a Free scope is refused its 6th client and 11th monthly invoice **by the server**, with the request crafted directly against Convex rather than through the UI.

---

## Phase B5 — Clients

**Branch:** `feat/b5-clients`

CRUD in `convex/clients.ts` — list (paginated, searchable, archived filter), get, create, update, archive, delete. Built on `scopedQuery` / `scopedMutation`, so scoping, row-level security, counters, and audit all arrive from the wrappers rather than from per-function code; this phase writes business logic only. Per-client invoice history uses `getManyFrom` from `convex-helpers/server/relationships`, and the outstanding balance reads the trigger-maintained denormalized fields. Quota is asserted on create; capability is checked on every write.

---

## Phase B6 — Invoices, payments, and the public link

**Branch:** `feat/b6-invoices`

The largest backend phase.

- **Numbering** — `nextInvoiceSeq` on `scopeSettings`, incremented in the same transaction. Convex mutations are serializable, so no gap/collision handling is needed.
- **Totals** — computed **server-side** from line items in integer cents; client-supplied totals are ignored, not trusted. Per-line tax, then subtotal → tax → discount → total.
- **Status machine** — `draft → sent → viewed → paid`, with `overdue` derived and `void` terminal. Illegal transitions throw. `Date.now()` is read in mutations only, never in queries (guidelines rule).
- **Payments** — partial payments supported. Recording one recomputes the invoice status in the mutation; the client's denormalized balances follow from the payments trigger, inside the same transaction.
- **Public link** — `publicToken` minted at send time. `convex/public.ts` holds the *only* unauthenticated functions in the codebase: a query returning a deliberately narrow projection (no ids, no audit, nothing about other invoices), and an idempotent mutation that stamps `viewedAt` and flips `sent → viewed` exactly once. Both are read carefully at review time.
- **Overdue cron** — `crons.cron("0 3 * * *", ...)`. Only `crons.cron` / `crons.interval` are used; the `.daily()` helpers are forbidden by the guidelines.

---

## Phase B7 — Expenses, categories, and file storage

**Branch:** `feat/b7-expenses`

CRUD plus category management. Receipts use Convex file storage via a generated upload URL; `receiptStorageId` lives on the scoped expense row and the download URL is only ever minted by a query that has already passed `getInScope`, which is what makes storage org-scoped in practice. `ctx.storage.getUrl()` can return `null` — handled, not assumed.

---

## Phase B8 — Reports

**Branch:** `feat/b8-reports`

Gated on the `reports` feature. Revenue by month/quarter/year, outstanding vs collected, P&L summary, expense breakdown by category, and cash-flow series. All aggregation runs server-side over `withIndex` date ranges with bounded reads, using `stream` from `convex-helpers/server/stream` where a report spans several indexes — the client receives totals, never raw rows. `@convex-dev/aggregate` is the documented scale path but is **not** installed; at seed volumes direct aggregation is correct and simpler.

---

## Phase B9 — Recurring invoices and AI receipt scanning

**Branch:** `feat/b9-recurring-and-ai`

- **Recurring** — gated on `recurring_invoices`. Daily `crons.cron("0 2 * * *", ...)` → `internalMutation` scanning `by_active_and_next_run`, generating invoices as drafts, advancing `nextRunAt`. Quota still applies. Batched with `ctx.scheduler.runAfter` continuation rather than one unbounded pass.
- **OCR** — gated on `receipt_scanning`. A `"use node"` action in its own file (the guidelines forbid mixing `"use node"` with queries/mutations) that pulls the receipt from storage, base64-encodes it, and calls OpenRouter with a JSON-schema-constrained prompt. Free vision models tried in order: `qwen/qwen2.5-vl-72b-instruct:free` → `meta-llama/llama-3.2-11b-vision-instruct:free` → `google/gemini-2.0-flash-exp:free`. Extracted vendor/date/total/tax/category are written back as a **suggestion the user confirms**, never silently applied. `OPENROUTER_API_KEY` goes in Convex env.

---

# PART II — FRONTEND

## Phase F0 — Design foundation (interactive)

**Branch:** `design/f0-direction`

This is the impeccable ritual and **it needs you in the loop** — there are decision rounds you answer in a browser.

1. `impeccable context`, then `impeccable init` → `PRODUCT.md`.
2. Mode is **Operate** for the whole authenticated app (`reference/operate.md`): earned familiarity, one type family, fixed rem scale at a 1.125–1.2 ratio, Restrained colour with a second neutral layer for the sidebar, 150–250ms transitions, skeletons not spinners, every interactive component carrying all seven states. The marketing page at `/` is the one **Persuade** surface.
3. `impeccable concept-seed --scope direction --mode operate` → a decision page you pick a direction from, with re-roll and the standing exit available.
4. Direction contract written into the surface brief; `DESIGN.md` + `.impeccable/design.json` are written at *finish*, from the built world, not before.
5. Design tokens land in `app/globals.css` — replacing the current all-grey `oklch` placeholder scale and settling the real typeface, which supersedes the Phase 0 Geist stopgap.

### F0.6 App mark and favicon

The icon is **derived from the locked direction, not invented before it** — a mark chosen ahead of the visual world is a mark the world then has to accommodate. So it is produced here, after step 3, in the direction's own palette and geometry.

Deliverables, all hand-authored SVG (no raster tracing, no generic icon-library glyph):

- **`app/icon.svg`** — the favicon. Next 16 picks this up from the `app/` directory automatically and generates the `<link>` tags; it replaces the existing `app/favicon.ico`, which is still the stock Next.js default. Authored on a 32×32 grid so it survives being rendered at 16px in a browser tab: one idea, closed shapes, no hairlines under 2px, no text, and legible as a solid silhouette. Includes a `prefers-color-scheme: dark` media query inside the SVG so it does not disappear against a dark tab strip.
- **`app/apple-icon.svg`** — 180×180 variant with the safe-area padding iOS expects and an opaque ground, since iOS composites no background of its own.
- **`components/brand/logo.tsx`** — the full lockup (mark + wordmark) used in the sidebar and on the invoice PDF, `currentColor`-driven so it inherits theme, with the mark usable standalone at small sizes.

Concept direction: the mark should come from the accounting world's own visual language rather than the SaaS-default abstract swoosh — a ledger rule, a column of figures, a balance, a cash-flow curve, the bracket notation of a balanced book. Which of these is right is decided by the direction locked in step 3, so I'll bring 3 candidates rendered at actual tab size (16px, 32px, and 180px side by side) for you to pick from before it ships. Judging a favicon at 400px is how unreadable favicons get approved.

Deliverable is `PRODUCT.md`, the surface brief with its six contract blocks, the token layer, and the icon set. No feature UI yet.

## Phase F1 — App shell

**Branch:** `feat/f1-app-shell`

Install `motion` and register the `@bklit` namespace in `components.json` (see A5) before writing UI; individual Bklit charts are added later, per chart, as F2/F6 need them (`npx shadcn@latest add @bklit/<chart>`). Kokonut UI components are pulled in ad hoc, per surface, as a starting point rather than bulk-installed. Sidebar + top bar, `<OrganizationSwitcher>` with `hidePersonal={false}` so Personal Account is reachable, a persistent scope indicator so it is never ambiguous which books you are looking at, command palette (a Kokonut UI command-palette pattern is a reasonable starting point, restyled per A5), and the full loading/empty/error vocabulary the rest of the app reuses. Role-aware nav: viewers do not see create affordances at all. The sidebar's reveal/collapse and route transitions are Motion's first job in the app — one authored moment, not per-element hover effects.

## Phase F2 — Dashboard

**Branch:** `feat/f2-dashboard`

Revenue overview, outstanding vs collected, cash flow, expense breakdown, recent activity. Charts are built from Bklit UI's composable primitives (axes, tooltips, legends, brush) rather than hand-rolled, restyled to the app's own status/chart palette per A5; composition, density, and layout still follow the `dataviz` skill regardless of which primitives assemble the chart. Empty states teach the product rather than saying "no data".

## Phase F3 — Clients · Phase F4 — Invoices · Phase F5 — Expenses

**Branches:** `feat/f3-clients`, `feat/f4-invoices`, `feat/f5-expenses`

F4 is the big one: list with filters, the line-item editor with live server-verified totals, template picker with branding, PDF download via the `@react-pdf/renderer` route handler, the public invoice page at `/i/:token` (unauthenticated, its own minimal layout), and recurring-invoice management behind an upgrade gate. This is also where the **stamp-strike** signature interaction (A5) ships: marking an invoice Sent, Paid, or Void plays a short Motion-driven animation of the status stamp striking the page, rather than a status field silently changing value. F5 carries receipt upload with a drag-drop dropzone and the OCR confirm-or-edit flow.

## Phase F6 — Reports · Phase F7 — Billing, settings, team

**Branches:** `feat/f6-reports`, `feat/f7-billing-settings`

F6's report charts reuse the same Bklit UI primitives and palette mapping established in F2 rather than introducing a second charting approach.

F7 renders **whichever plan family matches the active scope**: `<PricingTable for="organization" />` when an organization is active, `<PricingTable for="user" />` in personal scope (note it is a single `for` string prop — there is no `forOrganizations` boolean, and passing `for="organization"` with no active organization throws). Also the in-app checkout drawer, `<OrganizationProfile />` for team management and invitations, a seat meter showing members against the plan's cap, usage meters fed by `getUsageSummary`, company branding settings, and the audit-trail viewer for Owners.

The billing page states plainly which workspace a subscription applies to, because B3.8's separation is invisible otherwise and “I already pay for Pro” while looking at a Free organization is the support ticket this prevents.

## Phase F8 — Finish

**Branch:** `chore/f8-finish`

Batched desktop + mobile screenshot round, `impeccable detect --json`, then the `impeccable-finish-reviewer` agent with the full input packet, fixes applied in one batch, verdict pass, then the `impeccable-documenter` writes `DESIGN.md`. Plus a WCAG 2.1 AA pass and a real-data performance check.

---

## Phase S — Seeding

**Branch:** `feat/s-seed-data`

An `internalMutation` invoked via `npx convex run`, taking org ids as arguments so it is re-runnable and not hardcoded to one deployment.

| Scope | Tier | Shape of data |
|---|---|---|
| **Acme Inc.** | Free | Deliberately **at the caps** — exactly 5 clients and 10 invoices this month, so the quota walls are visible the moment you log in. ~20 expenses. |
| **Atharva Bakale Industries** | Pro | 18 months of history: ~24 clients, ~180 invoices across all statuses, ~120 expenses, 3 active recurring templates, partial payments, a handful genuinely overdue. |
| **NVIDIA Graphics** | Business | Similar volume plus multi-currency invoices (EUR/GBP/JPY) and receipts with OCR results attached, exercising the Business-only features. |
| **Personal scope** ×2 | Free and Pro | A small freelance dataset on each of `atharvabakale13@gmail.com` and `bakaleatharva13@gmail.com`. One is left on Free and one put on `pro_user`, which makes B3.8's rule directly observable: the Pro personal account still hits Free limits the moment it switches into Acme Inc. |

Both emails get membership in all three orgs with **different roles**, arranged so all four roles are reachable from a single login. `atharvabakale13@gmail.com` is Owner of Atharva Bakale Industries, Admin of NVIDIA Graphics, and Viewer of Acme Inc.; `bakaleatharva13@gmail.com` is Owner of Acme Inc., Accountant of Atharva Bakale Industries, and Admin of NVIDIA Graphics. Switching organizations in the switcher is therefore enough to exercise the whole matrix — including the Owner/Admin split, since the first account can change the plan in one org and only read it in another. Amounts follow a realistic seasonal curve rather than being uniformly random, and every row carries a plausible `_creationTime` so the reports have something honest to draw.

---

## Verification

Per phase: `pnpm lint` and `pnpm build` clean, `npx convex dev` deploying without schema errors, and the phase's own `convex-test` suite green.

End-to-end, once Part I is merged:

1. **Isolation** — signed in as a member of Acme, call every Convex query and mutation with ids belonging to NVIDIA Graphics. Every one must refuse. This is run directly against Convex, not through the UI, because the UI proves nothing about the server.
2. **Roles** — as Viewer, every write is refused server-side; as Accountant, settings, members, and billing are refused; **as Admin, settings and members succeed but billing, org deletion, and ownership transfer are refused**; as Owner, everything is permitted. The Admin case is the one that proves the new split, so it is tested against Convex directly rather than by looking at the UI.
3. **Quotas** — on Acme (Free), the 6th client and 11th invoice are refused with `UPGRADE_REQUIRED`; upgrading it in Clerk makes both succeed once the webhook lands.
4. **Features** — recurring invoices and OCR are refused on Acme and succeed on NVIDIA Graphics.
5. **Public link** — the invoice link opens in a logged-out browser, shows only that invoice, and flips its status to Viewed exactly once.
6. **Crons** — trigger both jobs manually from the Convex dashboard and confirm overdue marking and recurring generation.
7. **PDF** — downloads, opens, and matches the on-screen invoice.
8. **Design** — the finish reviewer returns `ship`, or its findings are resolved and re-scored.

---

## Branch and PR sequence

Each row is one PR against `master`. Nothing starts until the previous one is merged.

| # | Branch | Deliverable |
|---|---|---|
| 0 | `chore/phase-0-foundation` | Font fix, lint fix, Convex provider, middleware, `convex-helpers` + `svix` |
| B1 | `feat/b1-schema-tenancy` | Identity probe, schema, `convex-helpers` scope wrappers + RLS + triggers, isolation tests |
| B2 | `feat/b2-clerk-sync` | Webhook httpAction and sync mutations |
| B3 | `docs/b3-clerk-config` | Clerk setup manual: orgs, four roles (Owner ≠ Admin), permissions, org plans, **user plans**, webhooks |
| B4 | `feat/b4-entitlements-quotas` | Plan limits, feature gates, usage counters, audit |
| B5 | `feat/b5-clients` | Client CRUD |
| B6 | `feat/b6-invoices` | Invoices, payments, public link, overdue cron |
| B7 | `feat/b7-expenses` | Expenses, categories, receipt storage |
| B8 | `feat/b8-reports` | Report aggregations |
| B9 | `feat/b9-recurring-and-ai` | Recurring cron + OpenRouter OCR |
| F0 | `design/f0-direction` | PRODUCT.md, direction contract, tokens, app icon + favicon |
| F1 | `feat/f1-app-shell` | Shell, org switcher, nav, Motion + Bklit installed, Motion-driven shell transitions |
| F2 | `feat/f2-dashboard` | Dashboard + Bklit charts |
| F3 | `feat/f3-clients` | Clients UI |
| F4 | `feat/f4-invoices` | Invoices UI, PDF, public page, Motion stamp-strike interaction |
| F5 | `feat/f5-expenses` | Expenses UI, upload, OCR flow |
| F6 | `feat/f6-reports` | Reports UI (Bklit charts) |
| F7 | `feat/f7-billing-settings` | Pricing, checkout, team, settings, audit |
| F8 | `chore/f8-finish` | Finish review, a11y, DESIGN.md |
| S | `feat/s-seed-data` | Seed script + run |

**Phase B3 is a hard gate** *(waived for the code phases while B3 was skipped: B4 proceeded against a stubbed config; as of 2026-09-22, B3 is mostly done — see its status note above — with three Dashboard-only items still open before live, end-to-end verification can run)*. B4 onward depends on plans, features, and roles existing in Clerk. If the dashboard work stalls, backend phases B5–B9 can still proceed against a temporarily stubbed `getEntitlements`, but nothing merges to `master` until the real config is in place.

---

## Known risks

- **Clerk Billing is experimental.** Clerk's own docs say to pin `@clerk/nextjs` and `clerk-js`. Phase 0 pins them; a minor bump could still move the checkout API.
- **Dev-instance plans do not migrate to production.** Everything in B3 is re-done by hand against the production instance later. Budget for it; it is not a script.
- **The identity claim shape is unverified until B1.0 runs.** If Convex flattens `o` differently than expected, `requireScope()` changes shape — cheap at B1, expensive later. That is exactly why the probe is the first task rather than an assumption.
- **Custom organization roles are free in development but require Clerk's paid B2B Authentication add-on in production.** The whole four-role model — `org:owner`, `org:accountant`, `org:viewer` — costs nothing on this Development instance and becomes a paid line item the day you promote. The same add-on gates seat caps above 20. It changes nothing we build, since Convex derives capability from the role slug and would map a reduced role set just as happily, but it is a real cost attached to a design decision and better known now than at launch.
- **Kokonut UI's default look is the opposite of this app's direction.** It ships dark zinc, Geist type, and its own motion timing; every component pulled from it (F1 onward) needs re-coloring, re-typesetting, and re-timing to the Certified Ledger tokens before it ships, per A5. Treat it as a pattern source, not a drop-in kit — budget real time for the re-skin, not just the install.
- **`convex-helpers` is pre-1.0 (v0.1.124).** Its API has been stable in practice but the version number is honest about the guarantee. It is pinned exactly in Phase 0, and the surface we depend on is small and concentrated in `convex/lib/` — if a breaking change ever lands, three files absorb it rather than the whole backend.
- **OpenRouter free models are rate-limited and occasionally withdrawn.** The three-model fallback chain and a clean "scan failed, enter it manually" path are part of B9, not an afterthought.