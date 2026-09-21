# CashView

A multi-tenant accounting app for small teams and freelancers: invoicing, expense tracking, client management, and financial reporting, in the QuickBooks / Xero mould.

Work in a **personal account** or inside an **organization**, and switch between them at any time. Each is its own set of books, and one never sees the other's data.

> **Status:** under active development, built phase by phase. See [Roadmap](#roadmap) and the full [implementation plan](.claude/plans/PLAN.md).

## Features

| Area | What it does |
|---|---|
| **Invoicing** | Line items, per-line tax, discounts, automatic numbering, partial payments, and an invoice lifecycle from draft to paid. Totals are computed on the server, in integer cents. |
| **Sharing** | "Send" mints an unguessable public link. There is no email step. The link opens a logged-out invoice page and a PDF download. |
| **Expenses** | Categories, vendors, billable flags, receipt uploads, and AI receipt scanning that suggests fields for you to confirm. |
| **Clients** | Contact and billing details, invoice history, and outstanding balances kept current on every write. |
| **Reports** | Revenue, outstanding vs. collected, profit and loss, cash flow, and expense breakdown, aggregated server-side. |
| **Recurring invoices** | Weekly, monthly, quarterly, or yearly templates that generate drafts on a schedule. |
| **Teams** | Owner, Admin, Accountant, and Viewer roles with an audit trail of who changed what. |
| **Billing** | Free, Pro, and Business plans through Clerk Billing, for organizations and for personal accounts. |

### Plans

Limits are enforced by the backend, not just hidden in the interface.

| | Free | Pro | Business |
|---|---|---|---|
| Price | $0 | $19/mo · $190/yr | $49/mo · $490/yr |
| Clients | 5 | Unlimited | Unlimited |
| Invoices | 10 per month | Unlimited | Unlimited |
| Team seats | 1 | 5 | 20 |
| Financial reports | | ✓ | ✓ |
| Recurring invoices | | ✓ | ✓ |
| AI receipt scanning | | | ✓ |
| Multi-currency | | | ✓ |

### Roles

| | Owner | Admin | Accountant | Viewer |
|---|:---:|:---:|:---:|:---:|
| View clients, invoices, expenses, reports | ✓ | ✓ | ✓ | ✓ |
| Create and edit clients, invoices, expenses; send invoices; record payments | ✓ | ✓ | ✓ | |
| Manage settings and members; read the audit trail | ✓ | ✓ | | |
| Manage billing; delete or transfer the organization | ✓ | | | |

Personal accounts act as Owner of their own books. Any role the app does not recognise is treated as Viewer.

## Tech stack

| | |
|---|---|
| Framework | [Next.js](https://nextjs.org) 16 (App Router), React 19, TypeScript |
| Backend & database | [Convex](https://convex.dev) with [`convex-helpers`](https://github.com/get-convex/convex-helpers) |
| Auth, organizations, billing | [Clerk](https://clerk.com) |
| UI | Tailwind CSS 4, shadcn/ui on Base UI, lucide-react |
| PDF | `@react-pdf/renderer`, in a server route handler |
| Receipt OCR | OpenRouter vision models |
| Tests | Vitest, `convex-test` |

## How it works

Four decisions shape the codebase. The reasoning is in the [plan](.claude/plans/PLAN.md#architecture-decisions-that-shape-everything-downstream).

**1. Everything belongs to a scope.** Every tenant table carries a `scopeId` (the Clerk organization id, or the user id in personal scope) and a `scopeKind`. Every index starts with `scopeId`. Personal data goes through exactly the same mechanism as organization data, with no special case.

**2. The server decides who is asking.** Convex derives the scope and the caller's role from the verified session token alone. No public function accepts a scope or user id as an argument, so there is nothing for a crafted request to override.

**3. Isolation is structural, not a convention.** Functions are built from a small set of wrappers (`scopedQuery`, `scopedMutation`, ...) that inject the scope, so a handler cannot be written without one. Beneath them, the database itself is wrapped in row-level security: a query that forgets its scope filter returns nothing rather than another tenant's rows. Leaking data takes two independent mistakes.

**4. Entitlements are synced, not read from the token.** Clerk Billing webhooks keep a `subscriptions` table current, and plan limits and feature gates are checked against it inside Convex. That is also what makes counted quotas possible ("10 invoices a month"), which a token could never carry.

Audit logging, usage counters, and client balances are maintained by database triggers that run in the same transaction as the write, so a mutation cannot skip them and the numbers cannot drift.

## Getting started

### Prerequisites

- Node.js 20+ and [pnpm](https://pnpm.io)
- A [Clerk](https://clerk.com) application (a development instance is fine)
- A [Convex](https://convex.dev) account

### Setup

```bash
pnpm install
cp .env.example .env.local
```

Fill in `.env.local`. Running `pnpm backend` for the first time creates a Convex project and writes the `CONVEX_*` values for you. The Clerk keys come from your Clerk dashboard.

Two values live in the **Convex dashboard's** environment settings, not in `.env.local`:

| Variable | Purpose |
|---|---|
| `CLERK_FRONTEND_API_URL` | Your Clerk issuer domain. `convex/auth.config.ts` reads it to verify tokens. |
| `CLERK_WEBHOOK_SECRET` | Signs Clerk webhooks (needed once the sync phase lands). |

The Clerk dashboard also needs organizations enabled with **membership optional**, plus roles, plans, and a webhook. The exact values are written out in the plan's Clerk configuration phase.

### Run it

Use two terminals:

```bash
pnpm backend    # Convex: deploys functions and schema to your dev deployment
pnpm frontend   # Next.js on http://localhost:3000
```

### Scripts

| Command | |
|---|---|
| `pnpm frontend` | Next.js dev server |
| `pnpm backend` | Convex dev deployment, watching `convex/` |
| `pnpm build` | Production build |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest suite |

## Project structure

```
app/               Next.js routes and layouts
components/        React components (components/ui is shadcn)
convex/            Backend: schema, functions, tenancy core
  lib/             Shared backend code (scope, wrappers, triggers)
lib/               Frontend utilities
proxy.ts           Clerk request handling (Next 16's name for middleware)
.claude/plans/     The implementation plan
```

### A note on route protection

`proxy.ts` deliberately does not gate routes. Clerk has deprecated path-based gating there because it can be bypassed. Instead, every protected page, route handler, and server action calls `auth.protect()` itself, and Convex enforces access again on its side. Anything new that needs a signed-in user must do the same.

## Roadmap

Built backend first, then frontend, one branch and pull request per phase.

| Phase | Scope | |
|---|---|:---:|
| 0 | Foundation: fonts, lint, Convex provider, dependencies | Done |
| B1 | Schema and the tenancy core (scope, wrappers, row-level security, triggers) | Done |
| B2 | Clerk to Convex sync (webhooks) | Done |
| B3 | Clerk dashboard configuration guide | Skipped for now |
| B4 | Entitlements, quotas, feature gates | Done |
| B5 | Clients | Done |
| B6 | Invoices, payments, public link | Done |
| B7 | Expenses and receipt storage | Done |
| B8 | Reports | Done |
| B9 | Recurring invoices and AI receipt scanning | Next |
| F0 to F8 | Design direction, app shell, dashboard, feature UIs, billing and settings, final review | |
| S | Seed data | |

The [plan](.claude/plans/PLAN.md) has the detail for each phase, including acceptance criteria.

## Contributing

Each phase lands as its own pull request from a branch named for it (for example `feat/b1-schema-tenancy`), with one commit per sub-phase. Before opening one, make sure these pass:

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

Secrets stay out of the repository: `.env*` is ignored except `.env.example`.
