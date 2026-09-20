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

A related trap this avoids: Clerk's `has({ permission: 'org:invoices:manage' })` silently returns `false` unless a Billing *Feature* named after the permission's resource is attached to the payer's plan. Per your decision, Convex ignores Clerk permissions entirely and maps the **role slug** (`o.rol`) through a capability matrix in code. Clerk custom permissions remain available as optional sugar for the Next.js layer but are never load-bearing.

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

| Capability | admin (Owner) | accountant | viewer |
|---|:---:|:---:|:---:|
| `clients.read` · `invoices.read` · `expenses.read` · `reports.read` | ✓ | ✓ | ✓ |
| `clients.write` · `invoices.write` · `invoices.send` · `expenses.write` · `payments.record` | ✓ | ✓ | — |
| `settings.manage` · `members.manage` · `billing.manage` · `audit.read` | ✓ | — | — |

Personal scope grants everything. Unknown or unmapped roles — including Clerk's built-in `org:member` — fall back to **viewer**, so the failure path is least privilege rather than most.

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

You do every click here yourself; I supply the exact values and verify the result afterwards through the Clerk Backend API. **Every name and description below is final copy — paste it verbatim into the dashboard field.** These descriptions are what your teammates read in the role picker and what your customers read on the pricing table, so they are written to be read by people, not to be placeholders.

Work through the sections in order. Later ones depend on earlier ones: features must exist before plans can attach them, plans must exist before the webhook can report them, and organizations must be enabled before any of the org settings appear in the sidebar at all.

---

### B3.0 Before you start

Open [dashboard.clerk.com](https://dashboard.clerk.com) and confirm three things:

1. **You are on the right application and the right instance.** The instance switcher sits at the top of the sidebar and will read **Development**. Everything below is configured on Development. None of it copies to Production later — when you promote, you redo this whole phase by hand against the Production instance. That is a Clerk limitation, not an oversight in this plan.
2. **Your keys match.** The `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in `.env.local` starts with `pk_test_`. If it starts with `pk_live_` you are about to configure the wrong instance.
3. **You can reach the Convex dashboard too.** You will need it in B3.9 to set the webhook secret, and Convex environment variables are set there (or via CLI) — *not* in `.env.local`, because the webhook handler runs on Convex's servers, not in Next.js.

---

### B3.1 Enable Organizations, with membership optional

**Navigate:** Configure → **Organization Settings**

| Setting | Value | Why |
|---|---|---|
| Enable organizations | **On** | Nothing else in this section appears until this is on. |
| **Membership** | **`Membership optional`** | **The single most important setting in this phase.** |
| Allow users to create organizations | **On** | Users self-serve their first workspace instead of waiting on you. |
| Default role for new members | **Accountant** (set after B3.2 creates the role) | New invitees can keep books immediately but cannot touch billing or the team. |
| Maximum allowed memberships | Leave at the default | The real cap comes from the subscription plan's seat limit, configured in B3.6. Setting it here too would override the plan and confuse the upgrade path. |
| Verified domains | Off for now | Useful later for auto-joining by email domain; out of scope. |

**On `Membership optional`:** since 2025-08-22, Clerk defaults new instances to **Membership required**, which forces every signed-in user through a `choose-organization` session task and **disables personal accounts entirely**. If you leave that default, the personal-scope half of CashView silently cannot exist — users will be unable to reach the app without first creating an organization, and `<OrganizationSwitcher hidePersonal={false} />` will not offer a Personal Account entry no matter what props we pass it. Switch it to **optional** and confirm afterwards by signing in as a user with no organizations: you should land in the app, not on an org-selection screen.

---

### B3.2 Roles

**Navigate:** Configure → Organization Settings → **Roles** tab

CashView uses three roles. One already exists and is relabelled; two are created new.

#### Role 1 — Owner

- **Key:** `org:admin` *(built-in — do not create a new one, edit the existing Admin role and change its name to Owner)*
- **Name:** `Owner`
- **Description:**

> Complete, unrestricted control over this organization's CashView workspace. An Owner can do everything an Accountant can do, and in addition: invite new members by email address and revoke invitations that have not yet been accepted; remove existing members from the organization; change any member's role, including promoting another member to Owner; view and change the organization's subscription plan, update the payment method, and read the full billing history; edit the organization's profile, legal business name, registered address, and tax identification number; control invoice branding, including the uploaded logo, accent colour, and which invoice template is used; set the organization's base currency, default tax rate, invoice number prefix, and standard payment terms; and read the complete audit trail showing which member created, edited, or deleted every record, what changed, and exactly when. Clerk will refuse to remove or demote the last remaining Owner, so an organization can never be left without one. Assign this role only to the people who are genuinely accountable for the organization's finances and its subscription, because an Owner can start, upgrade, and cancel paid plans that charge the organization's payment method.

#### Role 2 — Accountant

- **Key:** `org:accountant` *(create)*
- **Name:** `Accountant`
- **Description:**

> Full day-to-day bookkeeping access with no administrative authority. An Accountant can create, edit, duplicate, send, void, and delete invoices; add and remove line items and set quantities, unit prices, per-line tax rates, and invoice-level discounts; record full or partial payments against invoices and reverse a payment recorded in error; add, edit, archive, and delete clients along with their contact details and billing addresses; log expenses, upload and replace receipt images, run AI receipt scanning on plans that include it, and manage the organization's expense categories; create and maintain recurring invoice schedules on plans that include them; and read every financial report, including revenue, profit and loss, cash flow, outstanding versus collected, and expense breakdown by category. An Accountant cannot invite, remove, or re-role members; cannot see or change the subscription, payment method, or billing history; cannot edit organization settings or invoice branding; and cannot read the audit trail. This is the correct default for in-house finance staff, bookkeepers, and external accountants who need to keep the books accurate but should not control the account itself.

#### Role 3 — Viewer

- **Key:** `org:viewer` *(create)*
- **Name:** `Viewer`
- **Description:**

> Strictly read-only access to the organization's finances. A Viewer can open and read any invoice, including its line items, tax breakdown, payment history, and current status; browse the client directory and see each client's invoice history and outstanding balance; view logged expenses, their categories, and any attached receipt images; and open every financial report and dashboard chart. A Viewer cannot create, edit, send, void, or delete anything anywhere in the application — every write is refused by the server itself, not merely hidden in the interface, so the restriction holds even against a hand-crafted request. A Viewer also cannot record payments, upload receipts, change any setting, manage members, see billing, or read the audit trail. Use this role for people who need visibility without the ability to change records: investors and advisors, an auditor during a review period, or a business partner who only needs to watch the numbers.

#### A note on `org:member`

Clerk ships a built-in `org:member` role that cannot be deleted. CashView does not use it. Convex maps it — and any other unrecognised role — to **Viewer**, so an unexpected role fails closed to the least privilege rather than falling open. Leave it in place and simply never assign it.

---

### B3.3 Permissions

**Navigate:** Configure → Organization Settings → **Permissions** tab

Because authorization is decoupled (architecture decision A3), **Convex does not read these**. Convex reads the role slug and applies its own capability matrix. These permissions exist so the Next.js layer can call `has({ permission })` for cosmetic gating — hiding a button a user could not successfully press anyway — and so the org roles read sensibly to anyone inspecting them in the Clerk dashboard.

Create each with the key, name, and description exactly as given.

| Key | Name |
|---|---|
| `org:invoices:manage` | Manage invoices |
| `org:expenses:manage` | Manage expenses |
| `org:clients:manage` | Manage clients |
| `org:reports:read` | View financial reports |
| `org:settings:manage` | Manage organization settings |
| `org:audit:read` | View audit trail |

**`org:invoices:manage` — Manage invoices**

> Grants the ability to create new invoices; edit existing drafts; add and remove line items and set their descriptions, quantities, unit prices, and per-line tax rates; apply invoice-level discounts; choose the invoice template, issue date, and due date; mark an invoice as sent and generate the public share link a client can open without signing in; record full or partial payments against an invoice and reverse one entered in error; void an invoice that was issued in error while keeping it in the record for audit purposes; and permanently delete a draft that was never sent. Also covers creating and editing recurring invoice schedules on plans that include that feature. Without this permission a member holding a read role can still open and read invoices, but every write operation is refused.

**`org:expenses:manage` — Manage expenses**

> Grants the ability to log new expenses with a vendor, amount, tax component, date, and payment method; attach, replace, or remove receipt images in the organization's scoped file storage; trigger AI receipt scanning on plans that include it and accept or correct the values it extracts; assign and reassign expenses to categories; create, rename, recolour, and delete the organization's custom expense categories; mark an expense as billable and link it to a client so it can be rebilled; and edit or delete previously logged expenses. Receipt files uploaded under this permission are stored against this organization only and are unreachable from any other organization or personal account, including by direct URL.

**`org:clients:manage` — Manage clients**

> Grants the ability to add new clients with a contact name, company name, email address, phone number, and full billing address; edit any of those details later; set a client's invoicing currency, which on multi-currency plans determines the currency of invoices raised against them; attach internal notes to a client record that never appear on an invoice; archive a client so they stop appearing in pickers while their invoice history is preserved intact; restore a client from the archive; and permanently delete a client that has no invoices against them. Deleting a client who does have invoice history is refused by the server so that the books stay internally consistent and no invoice is ever orphaned.

**`org:reports:read` — View financial reports**

> Grants access to the reporting section: revenue totals broken down by month, quarter, and year; the outstanding-versus-collected comparison showing what has been invoiced against what has actually been paid; the profit and loss summary combining invoiced revenue against logged expenses over a chosen period; the expense breakdown by category; and the cash-flow visualisation showing money in from payments against money out from expenses over time. Also covers exporting any report's underlying figures. Note that this permission gates the reports surface, while the reporting capability itself is additionally gated by the subscription plan — a member who holds this permission on a Free plan will still be shown the upgrade prompt rather than the reports.

**`org:settings:manage` — Manage organization settings**

> Grants the ability to edit the settings that shape every document the organization issues: the legal business name, registered address, contact email, phone number, and tax identification number printed on invoices; the invoice branding, including the uploaded logo, accent colour, and which of the built-in invoice templates is used; the base currency for the organization's books; the default tax rate applied to new invoice line items; the invoice number prefix and the next sequence number; the default payment terms in days that drive due-date calculation; and the standing footer note printed at the bottom of every invoice. These settings affect invoices that have already been drafted as well as future ones, which is why the permission is restricted to Owners.

**`org:audit:read` — View audit trail**

> Grants access to the audit trail: the append-only record of every create, edit, delete, status change, payment, send, and settings change made inside this organization, showing which member performed the action, what changed from what to what, and the exact time it happened. This is the record used to answer questions like "who voided this invoice" or "when did this client's billing address change", so it is deliberately restricted to Owners by default. Granting it more widely is a legitimate choice when an external auditor needs self-service access, but be aware that it exposes the activity of every member to whoever holds it.

#### Role → permission assignment

Set these on each role's edit screen.

| Permission | Owner | Accountant | Viewer |
|---|:---:|:---:|:---:|
| `org:invoices:manage` | ✓ | ✓ | — |
| `org:expenses:manage` | ✓ | ✓ | — |
| `org:clients:manage` | ✓ | ✓ | — |
| `org:reports:read` | ✓ | ✓ | ✓ |
| `org:settings:manage` | ✓ | — | — |
| `org:audit:read` | ✓ | — | — |
| `org:sys_memberships:manage` *(built-in)* | ✓ | — | — |
| `org:sys_memberships:read` *(built-in)* | ✓ | ✓ | ✓ |
| `org:sys_billing:manage` *(built-in)* | ✓ | — | — |
| `org:sys_profile:manage` *(built-in)* | ✓ | — | — |

**Known Clerk behaviour, and the reason Convex ignores all of this:** `has({ permission: 'org:invoices:manage' })` returns `false` unless a Billing *Feature* whose slug matches the permission's resource segment (`invoices`) is attached to the organization's active plan. Our feature slugs are deliberately product-shaped (`recurring_invoices`, `reports`, …) rather than resource-shaped, so these permission checks will read `false` on some plans even for an Owner. That is harmless here precisely because nothing security-relevant depends on them — but it is exactly the trap that would have made a permission-based Convex authorization model fail silently and intermittently.

---

### B3.4 Enable Billing

**Navigate:** Configure → **Billing** → Settings

1. Click **Enable Billing**.
2. When asked for a payment gateway, choose the **Clerk development gateway** (the shared test gateway). On a Development instance this requires **no Stripe account at all** and lets you run real checkouts with test cards. A production instance would instead require connecting your own Stripe account here.
3. Clerk auto-creates two starter plans, `free_user` and `free_org`. Keep both — B3.6 and B3.7 repurpose them rather than creating duplicates.

Test card for checkout flows on the dev gateway: `4242 4242 4242 4242`, any future expiry, any CVC.

---

### B3.5 Features

**Navigate:** Configure → Billing → **Features**

Create all four before touching plans — a plan can only attach a feature that already exists. **The slug is the exact string Convex stores and compares against**, so it must match character for character.

**`recurring_invoices` — Recurring invoices**

> Turn any invoice into a schedule that issues itself. Choose weekly, monthly, quarterly, or yearly, set a start date and an optional end date, and CashView generates each new invoice automatically on the due day with the line items, tax rates, and payment terms carried forward. Generated invoices arrive as drafts so they can be reviewed before sending, the schedule can be paused and resumed at any time, and invoice numbering continues in the same sequence as manually created invoices. Intended for retainers, subscriptions, and any client billed the same amount on a predictable cadence.

**`reports` — Financial reports**

> The full reporting suite: revenue trends broken down by month, quarter, and year; a profit and loss summary that sets invoiced revenue against logged expenses for any period; cash-flow visualisation showing money received against money spent over time; an outstanding-versus-collected view that separates what has been billed from what has actually landed; and an expense breakdown by category. Every figure is computed server-side from the organization's own records and can be exported. Without this feature the dashboard still shows current balances, but the historical and analytical views are unavailable.

**`ai_receipt_scanning` — AI receipt scanning**

> Photograph or upload a receipt and have CashView read it for you. The vendor name, transaction date, total amount, tax component, and the most likely expense category are extracted automatically and presented as a pre-filled expense you review, correct if needed, and confirm — nothing is ever saved without your approval. Works with photographs taken on a phone, scanned documents, and PDF receipts, and handles the common case of a crumpled or poorly lit receipt. Removes most of the typing from expense logging, which is where expense tracking usually breaks down.

**`multi_currency` — Multi-currency invoicing**

> Invoice each client in their own currency while keeping your books in one base currency. Set a currency per client and every invoice raised against them is issued, displayed, and exported in that currency, with the exchange rate captured at issue time so historical invoices never silently change value. Reports and dashboard totals continue to be presented in your base currency, converted at the rate recorded on each invoice, so revenue across currencies remains directly comparable. Intended for anyone billing clients outside their home market.

---

### B3.6 Organization Plans

**Navigate:** Configure → Billing → Plans → **Organization Plans** tab

This tab is for subscriptions **paid for by an organization and shared by everyone in it**. A plan's type is fixed at creation and cannot be changed afterwards — if you create one in the wrong tab you must delete it and start again, so check the tab heading before each one.

#### Plan 1 — Free (organization)

- **Slug:** `free_org` *(already exists — edit it, do not create a second)*
- **Name:** `Free`
- **Price:** $0
- **Seats / maximum members:** `1`
- **Features attached:** none
- **Description:**

> Everything you need to send your first invoices, at no cost and with no card required. Includes up to 5 clients, up to 10 invoices per calendar month, unlimited expense logging with receipt uploads, PDF invoice generation, public share links your clients can open without signing in, and the live dashboard showing what you are owed and what you have collected. Limited to a single user, so it suits a solo operator trying CashView before committing. Recurring invoices, the reporting suite, AI receipt scanning, and multi-currency invoicing are not included. Your data is never held hostage — the client and invoice caps stop you creating more, they never lock you out of what you have already recorded.

#### Plan 2 — Pro (organization)

- **Slug:** `pro_org` *(create)*
- **Name:** `Pro`
- **Price:** `$19` monthly / `$190` annual
- **Seats / maximum members:** `5`
- **Features attached:** `recurring_invoices`, `reports`
- **Description:**

> For a growing business that has outgrown spreadsheets. Removes every cap on the Free plan — unlimited clients and unlimited invoices every month — and adds up to 5 team members, each with their own login and role, so your bookkeeper and your accountant can work in the same books without sharing a password. Adds recurring invoices for retainers and subscriptions, and unlocks the full reporting suite: revenue trends, profit and loss, cash flow, and expense breakdown by category. Includes everything in Free. Billed to the organization rather than to individual members, and the annual option works out at two months free.

#### Plan 3 — Business (organization)

- **Slug:** `business_org` *(create)*
- **Name:** `Business`
- **Price:** `$49` monthly / `$490` annual
- **Seats / maximum members:** `20`
- **Features attached:** `recurring_invoices`, `reports`, `ai_receipt_scanning`, `multi_currency`
- **Description:**

> For established teams billing across borders and processing expenses at volume. Includes everything in Pro, raises the team limit to 20 members, and adds the two features that save the most time at scale: AI receipt scanning, which reads vendor, date, total, tax, and category straight off a photographed receipt so expense logging stops being data entry; and multi-currency invoicing, which lets you bill each client in their own currency while your reports stay in one base currency at the exchange rate captured when each invoice was issued. Billed to the organization and shared by every member.

#### Seats — read this before setting the numbers

- **Clerk enforces the seat cap itself**, at invite and join time. The application does not need its own blocking logic and this plan does not build any. The UI still *displays* the limit and how much of it is used, because an invite that fails with no warning is a bad experience.
- **The price does not scale with members.** A seat-limited plan is a fixed price with a ceiling, not per-seat billing. Adding a fourth member to Pro does not change the bill; adding a sixth is refused until the organization upgrades.
- **Caps above 20, or genuinely unlimited, require Clerk's paid B2B Authentication add-on.** That is why Business is set to 20 rather than unlimited on this Development instance. If you do not enable that add-on, Clerk's cap of 20 is the one that actually binds, so the UI must read the number off the plan rather than print the word "unlimited". Phase B4's `PLAN_LIMITS` records Business seats as `20` for this reason, with a comment pointing here.

---

### B3.7 User Plans (personal scope)

**Navigate:** Configure → Billing → Plans → **User Plans** tab

This tab is for subscriptions **paid for by an individual and applying only to their personal workspace**. These are not optional extras. A freelancer who never creates an organization reaches the app entirely through personal scope, and without these plans that user would be permanently stuck on Free with no way to give you money.

Create all three. Same features and same shape as the organization plans, priced lower because there is only ever one person using them.

#### Plan 1 — Free (personal)

- **Slug:** `free_user` *(already exists — edit it)*
- **Name:** `Free`
- **Price:** $0
- **Seats:** not applicable — personal scope is always exactly one person
- **Features attached:** none
- **Description:**

> Start invoicing today without a card. Your personal workspace includes up to 5 clients, up to 10 invoices per calendar month, unlimited expense logging with receipt uploads, PDF invoice generation, and public share links your clients can open without signing in. Ideal for a freelancer or side business finding out whether CashView fits before paying for anything. Recurring invoices, the reporting suite, AI receipt scanning, and multi-currency invoicing are not included. Your personal books stay entirely separate from any organization you later join or create.

#### Plan 2 — Pro (personal)

- **Slug:** `pro_user` *(create)*
- **Name:** `Pro`
- **Price:** `$9` monthly / `$90` annual
- **Features attached:** `recurring_invoices`, `reports`
- **Description:**

> For the independent professional whose invoicing has become real work. Removes the client and monthly invoice caps entirely, adds recurring invoices so retainer clients bill themselves on schedule, and unlocks the full reporting suite — revenue trends, profit and loss, cash flow, and expense breakdown by category — which is what turns a pile of invoices into something you can hand an accountant at year end. Includes everything in Free. Applies to your personal workspace only; if you also belong to an organization, that organization carries its own separate subscription.

#### Plan 3 — Business (personal)

- **Slug:** `business_user` *(create)*
- **Name:** `Business`
- **Price:** `$24` monthly / `$240` annual
- **Features attached:** `recurring_invoices`, `reports`, `ai_receipt_scanning`, `multi_currency`
- **Description:**

> For the established independent consultant working across currencies and expensing at volume. Includes everything in Pro and adds the two features that remove the most manual work: AI receipt scanning, which reads the vendor, date, total, tax, and category directly from a photographed receipt so logging an expense takes seconds rather than minutes; and multi-currency invoicing, which lets you bill international clients in their own currency while your own reports stay in one base currency at the rate captured when each invoice was issued. Applies to your personal workspace only.

---

### B3.8 How organization plans, members, and personal plans fit together

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

### B3.9 Webhooks — Clerk → Convex

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

### B3.10 Confirm the session token carries the organization claim

**Navigate:** Configure → **Sessions** → Customize session token

You should not need to change anything — Clerk includes the compact `o` claim (`{ id, rol, per, slg, fpm }`) by default whenever an organization is active. Open the claims editor and confirm it has not been customised in a way that removes it. If it is untouched, leave it alone.

Do **not** add `{{org.id}}` / `{{org.role}}` as custom top-level claims. That duplicates data already present under `o` under different names, and it is how a codebase ends up with two sources of truth for the caller's organization. Phase B1.0's probe reads whatever is actually in the token and `requireScope()` is written against that.

---

### B3.11 Verification checklist

Tick these off before opening the B3 PR. I will independently read the configuration back through the Clerk Backend API and include the diff in the PR description.

- [ ] Organizations enabled, membership mode reads **optional**
- [ ] Signing in as a user with zero organizations lands in the app, not on an org-selection screen
- [ ] Three roles exist: `org:admin` renamed Owner, `org:accountant`, `org:viewer`, each with its full description pasted
- [ ] Six custom permissions exist and are assigned per the matrix in B3.3
- [ ] Default role for new members is Accountant
- [ ] Billing enabled on the Clerk development gateway
- [ ] Four features exist with slugs spelled exactly `recurring_invoices`, `reports`, `ai_receipt_scanning`, `multi_currency`
- [ ] Three **organization** plans: `free_org`, `pro_org`, `business_org`, with seats 1 / 5 / 20 and the right features attached
- [ ] Three **user** plans: `free_user`, `pro_user`, `business_user`, with the right features attached
- [ ] Webhook endpoint points at the **`.site`** domain and is subscribed to all fourteen events
- [ ] `CLERK_WEBHOOK_SECRET` set in **Convex** env and confirmed by `npx convex env list`
- [ ] A test event returns 200 and appears in `npx convex logs`

**Acceptance:** the Backend API read-back matches every table in this section, and a real organization created through the UI produces its `organizations`, `memberships`, `scopeSettings`, and `subscriptions` rows in Convex within a few seconds.

---

## Phase B4 — Entitlements, quotas, and audit

**Branch:** `feat/b4-entitlements-quotas`

`convex/lib/entitlements.ts` holding the single source of truth:

```ts
// Keyed by planKey, which the webhook derives from the Clerk plan slug:
//   free_org | free_user -> "free"   pro_org | pro_user -> "pro"   business_org | business_user -> "business"
// The same limits apply whether the payer is an organization or a user; only `seats` differs,
// and in personal scope seats is always 1 because a personal workspace has exactly one member.
const PLAN_LIMITS = {
  free:     { clients: 5,        invoicesPerMonth: 10,       orgSeats: 1,  features: [] },
  pro:      { clients: Infinity, invoicesPerMonth: Infinity, orgSeats: 5,  features: ["recurring_invoices", "reports"] },
  // orgSeats 20, not Infinity: Clerk caps seats at 20 without the paid B2B Authentication
  // add-on (see B3.6), so Clerk's number is the one that actually binds. The UI reads this
  // value rather than printing the word "unlimited".
  business: { clients: Infinity, invoicesPerMonth: Infinity, orgSeats: 20, features: ["recurring_invoices", "reports", "ai_receipt_scanning", "multi_currency"] },
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
- **OCR** — gated on `ai_receipt_scanning`. A `"use node"` action in its own file (the guidelines forbid mixing `"use node"` with queries/mutations) that pulls the receipt from storage, base64-encodes it, and calls OpenRouter with a JSON-schema-constrained prompt. Free vision models tried in order: `qwen/qwen2.5-vl-72b-instruct:free` → `meta-llama/llama-3.2-11b-vision-instruct:free` → `google/gemini-2.0-flash-exp:free`. Extracted vendor/date/total/tax/category are written back as a **suggestion the user confirms**, never silently applied. `OPENROUTER_API_KEY` goes in Convex env.

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

Sidebar + top bar, `<OrganizationSwitcher>` with `hidePersonal={false}` so Personal Account is reachable, a persistent scope indicator so it is never ambiguous which books you are looking at, command palette, and the full loading/empty/error vocabulary the rest of the app reuses. Role-aware nav: viewers do not see create affordances at all.

## Phase F2 — Dashboard

**Branch:** `feat/f2-dashboard`

Revenue overview, outstanding vs collected, cash flow, expense breakdown, recent activity. Charts follow the `dataviz` skill. Empty states teach the product rather than saying "no data".

## Phase F3 — Clients · Phase F4 — Invoices · Phase F5 — Expenses

**Branches:** `feat/f3-clients`, `feat/f4-invoices`, `feat/f5-expenses`

F4 is the big one: list with filters, the line-item editor with live server-verified totals, template picker with branding, PDF download via the `@react-pdf/renderer` route handler, the public invoice page at `/i/:token` (unauthenticated, its own minimal layout), and recurring-invoice management behind an upgrade gate. F5 carries receipt upload with a drag-drop dropzone and the OCR confirm-or-edit flow.

## Phase F6 — Reports · Phase F7 — Billing, settings, team

**Branches:** `feat/f6-reports`, `feat/f7-billing-settings`

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

Both emails get membership in all three orgs with **different roles** — Owner in one, Accountant in another, Viewer in the third — so you can see the permission matrix behave without juggling accounts. Amounts follow a realistic seasonal curve rather than being uniformly random, and every row carries a plausible `_creationTime` so the reports have something honest to draw.

---

## Verification

Per phase: `pnpm lint` and `pnpm build` clean, `npx convex dev` deploying without schema errors, and the phase's own `convex-test` suite green.

End-to-end, once Part I is merged:

1. **Isolation** — signed in as a member of Acme, call every Convex query and mutation with ids belonging to NVIDIA Graphics. Every one must refuse. This is run directly against Convex, not through the UI, because the UI proves nothing about the server.
2. **Roles** — as Viewer, every write is refused server-side; as Accountant, settings and billing are refused; as Owner, everything is permitted.
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
| B3 | `docs/b3-clerk-config` | Clerk setup manual: orgs, roles, permissions, org plans, **user plans**, webhooks |
| B4 | `feat/b4-entitlements-quotas` | Plan limits, feature gates, usage counters, audit |
| B5 | `feat/b5-clients` | Client CRUD |
| B6 | `feat/b6-invoices` | Invoices, payments, public link, overdue cron |
| B7 | `feat/b7-expenses` | Expenses, categories, receipt storage |
| B8 | `feat/b8-reports` | Report aggregations |
| B9 | `feat/b9-recurring-and-ai` | Recurring cron + OpenRouter OCR |
| F0 | `design/f0-direction` | PRODUCT.md, direction contract, tokens, app icon + favicon |
| F1 | `feat/f1-app-shell` | Shell, org switcher, nav |
| F2 | `feat/f2-dashboard` | Dashboard + charts |
| F3 | `feat/f3-clients` | Clients UI |
| F4 | `feat/f4-invoices` | Invoices UI, PDF, public page |
| F5 | `feat/f5-expenses` | Expenses UI, upload, OCR flow |
| F6 | `feat/f6-reports` | Reports UI |
| F7 | `feat/f7-billing-settings` | Pricing, checkout, team, settings, audit |
| F8 | `chore/f8-finish` | Finish review, a11y, DESIGN.md |
| S | `feat/s-seed-data` | Seed script + run |

**Phase B3 is a hard gate.** B4 onward depends on plans, features, and roles existing in Clerk. If the dashboard work stalls, backend phases B5–B9 can still proceed against a temporarily stubbed `getEntitlements`, but nothing merges to `master` until the real config is in place.

---

## Known risks

- **Clerk Billing is experimental.** Clerk's own docs say to pin `@clerk/nextjs` and `clerk-js`. Phase 0 pins them; a minor bump could still move the checkout API.
- **Dev-instance plans do not migrate to production.** Everything in B3 is re-done by hand against the production instance later. Budget for it; it is not a script.
- **The identity claim shape is unverified until B1.0 runs.** If Convex flattens `o` differently than expected, `requireScope()` changes shape — cheap at B1, expensive later. That is exactly why the probe is the first task rather than an assumption.
- **`convex-helpers` is pre-1.0 (v0.1.124).** Its API has been stable in practice but the version number is honest about the guarantee. It is pinned exactly in Phase 0, and the surface we depend on is small and concentrated in `convex/lib/` — if a breaking change ever lands, three files absorb it rather than the whole backend.
- **OpenRouter free models are rate-limited and occasionally withdrawn.** The three-model fallback chain and a clean "scan failed, enter it manually" path are part of B9, not an afterthought.