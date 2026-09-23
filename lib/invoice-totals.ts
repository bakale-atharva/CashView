/**
 * Client-side mirror of convex/lib/invoiceMath.ts's arithmetic, for the line
 * item editor's live preview. Deliberately not authoritative and never
 * throws: the server recomputes and validates everything on submit
 * (convex/invoices.ts), so a preview that is briefly wrong while someone is
 * mid-keystroke is harmless.
 */

export type LineItemDraft = {
  description: string;
  quantity: string;
  unitPriceCents: string;
  taxRatePct: string;
};

export function emptyLineItem(): LineItemDraft {
  return { description: "", quantity: "1", unitPriceCents: "0", taxRatePct: "0" };
}

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export type PreviewTotals = {
  lines: { amountCents: number; taxCents: number }[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

export function previewTotals(lines: readonly LineItemDraft[], discountCents: number): PreviewTotals {
  const computed = lines.map((line) => {
    const quantity = num(line.quantity);
    const unitPriceCents = num(line.unitPriceCents);
    const taxRatePct = num(line.taxRatePct);
    const amountCents = Math.round(quantity * unitPriceCents);
    const taxCents = Math.round((amountCents * taxRatePct) / 100);
    return { amountCents, taxCents };
  });
  const subtotalCents = computed.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = computed.reduce((s, l) => s + l.taxCents, 0);
  const totalCents = Math.max(0, subtotalCents + taxCents - (Number.isFinite(discountCents) ? discountCents : 0));
  return { lines: computed, subtotalCents, taxCents, totalCents };
}
