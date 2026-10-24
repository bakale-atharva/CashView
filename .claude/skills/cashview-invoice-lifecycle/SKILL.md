---
name: cashview-invoice-lifecycle
description: CashView's invoice status state machine and payment rules — draft, sent, viewed, overdue, paid, void; recording and deleting payments; the overdue cron. Use when adding invoice actions or statuses, changing payment recording, refunds, partial payments, the public invoice view, or anything that reads or writes invoice.status / paidCents.
---

# Invoice lifecycle

Authority: `convex/lib/invoiceStatus.ts` (`TRANSITIONS`, `canTransition`, `assertTransition`, `PAYABLE`, `isPastDue`, `statusAfterPaymentChange`). Callers: `convex/invoices.ts` (`send`, `voidInvoice`, `recordPayment`, `deletePayment`, `settleStatus`), `convex/invoicesCron.ts` (`markOverdue`), `convex/public.ts` (`markViewed`).

## State machine

```
draft ──send──▶ sent ──view──▶ viewed ──▶ paid
                  │                │        ▲
                  └──▶ overdue ◀───┘────────┘
sent | viewed | overdue ──void──▶ void   (terminal)
paid ──(payment removed)──▶ sent | viewed | overdue
```

- `draft → sent` only via `send`; `* → void` only via `voidInvoice` (from sent, viewed or overdue — not from draft or paid).
- **`overdue` is derived**: the 03:00 UTC cron moves `sent`/`viewed` invoices whose due day has fully passed (`dueDate < startOfUtcDay(now)`). Never let a user set it.
- **`paid` is derived** from payments: reached when `paidCents ≥ totalCents` (and total > 0); left again when a payment is deleted. The reopened status is `overdue` if past due, else `viewed` if `viewedAt` is set, else `sent`.
- Every status write goes through `assertTransition(from, to)`, which throws `ConvexError({ code: "INVALID_TRANSITION" })`. Add new statuses to `TRANSITIONS` first.

## Payments

- Only in `PAYABLE` statuses (`sent`, `viewed`, `overdue`); otherwise `conflict("invoice_not_payable")`.
- `amountCents` is a positive safe integer and **≤ total − paid** (no overpayment). Method 1–50 chars, reference ≤ 200.
- `paidCents` and the client's balances are maintained by the payments trigger (`convex/lib/triggers.ts`) in the same transaction. Never patch `paidCents` by hand; insert or delete a `payments` row and then call `settleStatus`.
- A payment is in its invoice's currency.

## Checklist for a change

1. Update `TRANSITIONS` and its diagram comment.
2. Route the write through `assertTransition`.
3. If it affects money owed, go through payments + triggers, not direct patches.
4. Gate with the right capability (`invoices.send`, `invoices.write`, `payments.record`).
5. Extend `convex/lib/invoiceStatus.test.ts` and `convex/invoices.test.ts`.
