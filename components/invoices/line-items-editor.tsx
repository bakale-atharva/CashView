"use client";

import { Plus, Trash2 } from "lucide-react";
import { formatCents } from "@/lib/money";
import type { LineItemDraft } from "@/lib/invoice-totals";
import { emptyLineItem, previewTotals } from "@/lib/invoice-totals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The invoice/recurring-template line item table. Totals shown here are a
 * client-side preview (lib/invoice-totals.ts) for instant feedback; the
 * server (convex/lib/invoiceMath.ts) recomputes and validates the real
 * totals on submit, so this never needs to be exact mid-keystroke.
 */
export function LineItemsEditor({
  lines,
  onChange,
  discountCents,
  onDiscountChange,
  currency,
}: {
  lines: LineItemDraft[];
  onChange: (lines: LineItemDraft[]) => void;
  discountCents: number;
  onDiscountChange: (cents: number) => void;
  currency: string;
}) {
  const totals = previewTotals(lines, discountCents);

  function update(i: number, patch: Partial<LineItemDraft>) {
    onChange(lines.map((line, idx) => (idx === i ? { ...line, ...patch } : line)));
  }

  function remove(i: number) {
    onChange(lines.filter((_, idx) => idx !== i));
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="w-1/2 px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Qty</th>
              <th className="px-3 py-2 font-medium">Unit price</th>
              <th className="px-3 py-2 font-medium">Tax %</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <td className="px-3 py-2">
                  <Input
                    value={line.description}
                    onChange={(e) => update(i, { description: e.target.value })}
                    placeholder="Design services"
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="w-20"
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(e) => update(i, { quantity: e.target.value })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="w-28"
                    inputMode="decimal"
                    value={line.unitPriceCents}
                    onChange={(e) => update(i, { unitPriceCents: e.target.value })}
                  />
                </td>
                <td className="px-3 py-2">
                  <Input
                    className="w-20"
                    inputMode="decimal"
                    value={line.taxRatePct}
                    onChange={(e) => update(i, { taxRatePct: e.target.value })}
                  />
                </td>
                <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                  {formatCents(totals.lines[i]?.amountCents ?? 0, currency)}
                </td>
                <td className="px-1 py-2 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => remove(i)}
                    disabled={lines.length <= 1}
                  >
                    <Trash2 />
                    <span className="sr-only">Remove line</span>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...lines, emptyLineItem()])}>
        <Plus />
        Add line
      </Button>

      <div className="ml-auto flex max-w-xs flex-col gap-1.5 pt-2 text-sm">
        <div className="flex justify-between text-muted-foreground">
          <span>Subtotal</span>
          <span className="font-mono tabular-nums">{formatCents(totals.subtotalCents, currency)}</span>
        </div>
        <div className="flex justify-between text-muted-foreground">
          <span>Tax</span>
          <span className="font-mono tabular-nums">{formatCents(totals.taxCents, currency)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 text-muted-foreground">
          <span>Discount</span>
          <Input
            className="h-6 w-24 text-right font-mono"
            inputMode="decimal"
            value={discountCents === 0 ? "" : String(discountCents / 100)}
            placeholder="0.00"
            onChange={(e) => {
              const n = Number(e.target.value);
              onDiscountChange(Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0);
            }}
          />
        </div>
        <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold">
          <span>Total</span>
          <span className="font-mono tabular-nums">{formatCents(totals.totalCents, currency)}</span>
        </div>
      </div>
    </div>
  );
}
