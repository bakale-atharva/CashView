@AGENTS.md

## CashView domain skills

Before changing accounting logic, load the matching skill in `.claude/skills/`:

- `cashview-invoice-math`: totals, tax, discounts, integer cents
- `cashview-invoice-lifecycle`: invoice statuses and payments
- `cashview-reports`: reports, aging, currency conversion
- `cashview-recurring-invoices`: recurring schedules and generation

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
