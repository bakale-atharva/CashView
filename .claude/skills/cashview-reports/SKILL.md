---
name: cashview-reports
description: How CashView computes financial reports — revenue, receivables and AR aging, profit & loss, expense breakdown, cash flow — including accrual vs cash basis, period bucketing, base-currency conversion and row limits. Use when adding or changing a report, a dashboard metric, a chart's data, aging buckets, or any total that spans invoices, payments or expenses.
---

# Reports

Authority: `convex/lib/reportMath.ts` (pure helpers) and `convex/reports.ts` (queries). Read the header comment of `reports.ts` before changing anything.

## Basis

- **Revenue (accrual)**: issued invoices only (`sent`, `viewed`, `paid`, `overdue`; never `draft`/`void`), counted on `issueDate`. P&L revenue is **net of sales tax**: `totalCents − taxCents` (tax is owed onward; discount already applied).
- **Cash flow (cash basis)**: payments in on `paidAt`, expenses out on `spentAt`, with a running cumulative.
- **Receivables**: every open invoice (`sent`, `viewed`, `overdue`), whenever it was issued, balance `totalCents − paidCents`, aged as of the `asOf` argument.
- Sales tax and expense tax are reported separately, never mixed into profit.

## Rules

- **Time**: queries cannot read the clock, so `from`, `to` and `asOf` are arguments. `normalizeRange` widens to whole UTC days (`to` includes its last millisecond) and rejects over 240 periods.
- **Periods**: `periodKey` → `"2026-03"`, `"2026-Q1"`, `"2026"` (UTC). Build series with `periodRange` so empty periods still appear.
- **Currency**: convert to the scope's base currency with the invoice's stored `exchangeRate` (`convert` rounds once). A payment uses its invoice's rate. Anything that cannot be converted (invoice without a rate, non-base expense) is **excluded and counted under `excluded`** — never silently summed or dropped.
- **Aging buckets**: `current`, `1-30`, `31-60`, `61-90`, `90+`, by whole days past `dueDate` as of `startOfUtcDay(asOf)`.
- **Scale**: read at most `REPORT_ROW_LIMIT` (10,000) rows per table via the scoped indexes (`by_scopeId_and_issueDate`, `by_scopeId_and_paidAt`, `by_scopeId_and_spentAt`, `by_scopeId_and_status_and_dueDate`), `.take(limit + 1)` then `assertWithinLimit` — refuse with `RANGE_TOO_LARGE` rather than under-count.
- **Access**: every report calls `guard` → `reports.read` capability + `reports` plan feature, and returns aggregates only, never raw rows.
- **Percentages**: `percent(part, total)` → one decimal, `null` when total is 0.

## Adding a report

1. Reuse `invoiceFacts` / `paymentFacts` / `expenseFacts` and `emptySeries`.
2. Return `currency`, `granularity`, `series`, totals and `excluded`.
3. Add pure logic to `reportMath.ts` with tests in `reportMath.test.ts`; integration cases in `convex/reports.test.ts`.
