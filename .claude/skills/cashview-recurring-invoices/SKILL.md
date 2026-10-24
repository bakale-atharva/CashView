---
name: cashview-recurring-invoices
description: How CashView schedules and generates recurring invoices — weekly, monthly, quarterly, yearly occurrences without month-end drift, the daily generation cron, deferral on quota or plan limits, pause and resume. Use when touching recurring templates, schedules, nextRunAt, the 02:00 cron, or anything about repeating invoices or subscriptions billed by invoice.
---

# Recurring invoices

Authority: `convex/lib/recurrence.ts` (`occurrence`, `occurrenceAfter`, `occurrenceOnOrAfter`), `convex/recurring.ts` (template CRUD, pause/resume), `convex/recurringCron.ts` (`generateDue`, `generateOne`), `convex/crons.ts`.

## Scheduling

- **Every occurrence is computed from the start date**, never from the previous one: `occurrence(start, freq, k)`. A template starting on the 31st runs on the 31st where it exists, else the month's last day (Feb 28/29), and returns to the 31st afterwards — no drift.
- Weekly = start + k·7 days. Monthly/quarterly/yearly step 1/3/12 months with the day clamped to the month's length.
- Dates are UTC midnight.
- **Creating, editing or resuming never backfills**: `nextRunAt = occurrenceOnOrAfter(start, freq, today)`. Resume past `endDate` → `conflict("schedule_finished")`.

## Generation (cron, 02:00 UTC — before the 03:00 overdue job)

- `generateDue` takes active templates with `nextRunAt ≤ now` in batches of 50 via `by_isActive_and_nextRunAt`, runs `generateOne` per template, and reschedules itself only if a full batch made progress.
- `generateOne` re-checks the template, creates a **draft** invoice using the same `computeTotals` and invoice numbering as a person would, then sets `nextRunAt = occurrenceAfter(start, freq, now)`. **Missed runs during downtime are skipped, not made up.** Past `endDate` → `isActive: false`.
- **Defer, don't drop**: when the invoice quota or plan feature refuses, set `nextRunAt = tomorrow` and `lastError = reason`, so it generates as soon as allowed.
- **Stop** (`isActive: false`, reason in `lastError`) a template that can never run again: past `endDate`, `client_unavailable` (archived or deleted), `currency_changed` (recurring invoices are base-currency only), `no_line_items`, `invalid_template`.

## When changing

- Never compute the next date from `lastRunAt` or `nextRunAt`.
- Keep generation idempotent per run: re-check `isActive` and `nextRunAt` inside `generateOne`.
- Tests: `convex/lib/recurrence.test.ts` (month-end, leap years), `convex/recurring.test.ts`, `convex/recurringQuota.test.ts`.
