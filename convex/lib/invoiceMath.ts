import { v } from "convex/values";
import type { Infer } from "convex/values";
import { DAY_MS, startOfUtcDay } from "./dates";
import { invalidInput } from "./errors";

/**
 * Invoice totals, computed on the server from the line items. A client never
 * supplies a total, so there is none to trust. All money is integer cents.
 *
 * Order, as the plan specifies: each line's amount, then per-line tax, then
 * subtotal and tax summed, then a flat discount off the top, then the total.
 */

/** Generous, but bounded: a document may not hold an unbounded list. */
export const MAX_LINES = 100;
// Keeps every sum below 2^53 even with MAX_LINES lines at the cap.
const MAX_LINE_CENTS = 1e12;

export const vLineItemInput = v.object({
  description: v.string(),
  quantity: v.number(),
  unitPriceCents: v.number(),
  taxRatePct: v.number(),
});
export type LineItemInput = Infer<typeof vLineItemInput>;

export type ComputedLine = {
  position: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRatePct: number;
  amountCents: number;
  taxCents: number;
};

export type Totals = {
  lines: ComputedLine[];
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
};

export function computeTotals(lines: readonly LineItemInput[], discountCents = 0): Totals {
  if (lines.length < 1) throw invalidInput("lineItems", "Add at least one line item.");
  if (lines.length > MAX_LINES) {
    throw invalidInput("lineItems", `An invoice can have at most ${MAX_LINES} lines.`);
  }

  const computed = lines.map((line, i): ComputedLine => {
    const at = (field: string) => `lineItems.${i}.${field}`;

    const description = line.description.trim();
    if (description === "") throw invalidInput(at("description"), "This field is required.");
    if (description.length > 500) {
      throw invalidInput(at("description"), "Must be 500 characters or fewer.");
    }

    const { quantity, unitPriceCents, taxRatePct } = line;
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e6) {
      throw invalidInput(at("quantity"), "Enter a quantity above zero.");
    }
    if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) {
      throw invalidInput(at("unitPriceCents"), "Enter a price in whole cents.");
    }

    // Tax rates carry at most two decimals; work in basis points so the
    // arithmetic below stays exact integer maths.
    const rateBp = Math.round(taxRatePct * 100);
    if (
      !Number.isFinite(taxRatePct) ||
      taxRatePct < 0 ||
      taxRatePct > 100 ||
      Math.abs(rateBp - taxRatePct * 100) > 1e-6
    ) {
      throw invalidInput(at("taxRatePct"), "Enter a rate from 0 to 100 with at most two decimals.");
    }

    const amountCents = Math.round(quantity * unitPriceCents);
    if (amountCents > MAX_LINE_CENTS) {
      throw invalidInput(at("unitPriceCents"), "This line's amount is too large.");
    }
    const taxCents = Math.round((amountCents * rateBp) / 10_000);

    return { position: i, description, quantity, unitPriceCents, taxRatePct, amountCents, taxCents };
  });

  const subtotalCents = computed.reduce((sum, l) => sum + l.amountCents, 0);
  const taxCents = computed.reduce((sum, l) => sum + l.taxCents, 0);

  if (!Number.isSafeInteger(discountCents) || discountCents < 0) {
    throw invalidInput("discountCents", "Enter a discount in whole cents.");
  }
  if (discountCents > subtotalCents + taxCents) {
    throw invalidInput("discountCents", "The discount cannot exceed the invoice total.");
  }

  return {
    lines: computed,
    subtotalCents,
    taxCents,
    discountCents,
    totalCents: subtotalCents + taxCents - discountCents,
  };
}

/**
 * Resolves the issue and due dates (UTC midnight). Missing dates default to
 * today and to the scope's payment terms after the issue date.
 */
export function resolveDates(
  input: { issueDate?: number; dueDate?: number },
  paymentTermsDays: number,
  now: number,
): { issueDate: number; dueDate: number } {
  for (const [field, value] of [
    ["issueDate", input.issueDate],
    ["dueDate", input.dueDate],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw invalidInput(field, "Enter a valid date.");
    }
  }
  const issueDate = startOfUtcDay(input.issueDate ?? now);
  const dueDate = startOfUtcDay(input.dueDate ?? issueDate + paymentTermsDays * DAY_MS);
  if (dueDate < issueDate) {
    throw invalidInput("dueDate", "The due date cannot be before the issue date.");
  }
  return { issueDate, dueDate };
}

/** "INV-" + 7 -> "INV-0007". Wider numbers just grow. */
export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(4, "0")}`;
}
