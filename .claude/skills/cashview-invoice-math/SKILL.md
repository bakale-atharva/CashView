---
name: cashview-invoice-math
description: Rules for computing invoice money in CashView — line amounts, per-line tax, subtotal, discount, total, due dates and invoice numbers, all in integer cents. Use when adding or changing anything that touches invoice or recurring-invoice totals, line items, tax rates, discounts, fees, credits, rounding, or the line-item editor preview.
---

# Invoice math

The authority is `convex/lib/invoiceMath.ts` (`computeTotals`, `resolveDates`, `formatInvoiceNumber`). `lib/invoice-totals.ts` (`previewTotals`) is a non-authoritative client mirror for the editor's live preview. Read both before changing either.

## Invariants

- **All money is integer cents** (`*Cents` fields). Never store or sum floats of currency units. Convert at the UI edge only.
- **The server computes totals.** A client never sends `subtotalCents`/`taxCents`/`totalCents`; mutations take line items and call `computeTotals`. Recurring templates use the same function.
- **Order of operations is fixed:**
  1. `amountCents = round(quantity × unitPriceCents)` per line
  2. `taxCents = round(amountCents × rateBp / 10_000)` per line, where `rateBp = round(taxRatePct × 100)`
  3. `subtotalCents = Σ amountCents`, `taxCents = Σ line taxCents` (round per line, then sum — never tax the subtotal)
  4. flat `discountCents` off the top, after tax
  5. `totalCents = subtotal + tax − discount`
- **Bounds** (keep sums below 2^53): 1–`MAX_LINES` (100) lines; quantity in (0, 1e6]; `unitPriceCents` a non-negative safe integer; a line ≤ 1e12 cents; tax rate 0–100 with ≤ 2 decimals; description trimmed, 1–500 chars; discount a non-negative integer ≤ subtotal + tax.
- **Errors** go through `invalidInput(field, message)` with a field path like `lineItems.3.quantity`, so the form can highlight the field.
- **Dates** are UTC midnight (`startOfUtcDay`). Missing issue date → today; missing due date → issue + scope `paymentTermsDays`. Due before issue is rejected.
- **Numbers**: `formatInvoiceNumber("INV-", 7)` → `INV-0007`; wider numbers just grow.

## When changing things

- A new money field (late fee, shipping, credit) is integer cents, validated like `discountCents`, and must be added to `computeTotals`, to the `Totals` type, to the stored invoice fields, and to `previewTotals` so the preview matches.
- Keep `previewTotals` arithmetic identical to the server's. It may be lenient (never throws, clamps at 0), but must not compute differently for valid input. Note: it currently uses `taxRatePct / 100` directly rather than basis points; it only matches the server for rates with ≤ 2 decimals.
- Add cases to `convex/lib/invoiceMath.test.ts` for every rule you add: rounding at .5, max bounds, field paths in errors.

See `reference.md` for worked examples.
