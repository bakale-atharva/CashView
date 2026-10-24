# Invoice math — worked examples

## Per-line tax rounding

| Line | qty | unit (cents) | rate | amountCents | taxCents |
|---|---|---|---|---|---|
| 1 | 3 | 333 | 18% | 999 | round(999 × 1800 / 10000) = round(179.82) = 180 |
| 2 | 1.5 | 1999 | 5% | round(2998.5) = 2999 | round(149.95) = 150 |

subtotal = 3998, tax = 330, discount 500 → total = 3828.

Taxing the subtotal instead (3998 × …) would give different cents with mixed rates. Always round per line, then sum.

## Why basis points

`taxRatePct = 7.25` → `rateBp = 725`. `amountCents × 725 / 10000` keeps the multiplication in integers until the single final `Math.round`. A rate like `7.255` is rejected (more than two decimals).

## Discount rules

- Flat cents only, applied after tax.
- `discountCents > subtotal + tax` → `INVALID_INPUT` on `discountCents`.
- A percentage discount, if ever added, must be turned into cents once (rounded) and stored as cents.

## Dates

```ts
resolveDates({}, 30, now)              // { issueDate: today00:00Z, dueDate: today+30d }
resolveDates({ dueDate: yesterday }, 30, now) // throws INVALID_INPUT on dueDate
```
