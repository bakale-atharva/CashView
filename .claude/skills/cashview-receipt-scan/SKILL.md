---
name: cashview-receipt-scan
description: CashView's AI receipt scanning for expenses — upload checks, the begin/scan/finish action flow, the OpenRouter vision model chain, strict parsing of the model's reply, and the suggest-then-confirm apply/dismiss step. Use when touching receipts, OCR, expense auto-fill, the scanning models, or any feature that turns model output into stored data.
---

# Receipt scanning

Authority: `convex/lib/receiptScan.ts` (pure: prompt, request, parsing), `convex/receiptScan.ts` (`begin`, `finish`, `scan`, `applyScan`, `dismissScan`), `convex/lib/receipts.ts` (upload checks). Tests: `convex/lib/receiptScan.test.ts`, `convex/receiptScan.test.ts`. Business plan only (`receipt_scanning`).

## Core rule: the model only suggests

- The reply is **untrusted**. A receipt can contain text like "ignore your instructions". The prompt says image text is data, never instructions, and the reply is validated field by field (`parseScan`). Failing fields are dropped.
- Survivors go to `expense.ocrSuggestion`. **Nothing on the expense changes until a person calls `applyScan`**, which runs the same `normalizeExpenseInput` validation as a manual edit. `dismissScan` throws the suggestion away.

## Flow

1. `begin` (internal mutation): capability, plan feature, receipt present; refuses `scan_in_progress` unless the pending scan is older than `STALE_SCAN_MS` (2 min); marks `ocrStatus: "pending"`.
2. `scan` (action, default runtime, no `"use node"`): only JPEG/PNG/WebP; tries each of `SCAN_MODELS` (free OpenRouter models) in order with a 30 s timeout, `temperature: 0`, and a strict JSON schema; the first parseable answer wins.
3. `finish` (internal mutation): ignored if the receipt was replaced meanwhile; rechecks that the suggested category belongs to this scope; keeps ≤ 5000 chars of raw reply.
4. Every path out of `scan` records `done` or `failed`. An expense is never stuck pending. Scan problems are returned as `{ ok: false, reason }`; plan, permission and in-progress errors are thrown.

## Parsing rules (`parseScan`)

- Amounts: number or a strict decimal string; to cents with `toCents`, which shifts on the decimal text (`1.005` → 101, not 100). `0 < total ≤ 1e10`; `0 ≤ tax ≤ total`.
- Date: `YYYY-MM-DD` that round-trips, year ≥ 2000, not after tomorrow.
- Currency: 3 letters, upper-cased. Category: exact case-insensitive name match to one of the scope's categories.
- Fails only if vendor, amount and date are all missing.

## Don'ts

- Never log the request (it holds the API key and the image). Log only the error name.
- Never write model output straight to the expense, and never trust a model-supplied id.
- `OPENROUTER_API_KEY` is read through `env`. A missing key returns "Receipt scanning isn't set up yet."
