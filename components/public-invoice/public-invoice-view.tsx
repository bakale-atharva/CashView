"use client";

import { useMutation, useQuery } from "convex/react";
import { Download } from "lucide-react";
import { useEffect } from "react";
import { api } from "@/convex/_generated/api";
import { formatCents } from "@/lib/money";
import { StatusStamp } from "@/components/invoices/status-stamp";
import { LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * What a client sees at `/i/:token` — the only page in the app that is never
 * behind auth (convex/public.ts). No sidebar, no nav, no other invoices: just
 * this one document, exactly as convex/public.ts projects it.
 */
export function PublicInvoiceView({ token }: { token: string }) {
  const data = useQuery(api.public.getInvoiceByToken, { token });
  const markViewed = useMutation(api.public.markViewed);

  useEffect(() => {
    markViewed({ token });
  }, [token, markViewed]);

  if (data === undefined) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16">
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-24 text-center">
        <LogoMark className="size-6 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          This invoice link is no longer available. Ask the sender for a new one.
        </p>
      </div>
    );
  }

  const { seller, client } = data;

  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="rounded-xl border border-border bg-card p-8 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            {seller.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- external Convex storage URL, unknown dimensions
              <img src={seller.logoUrl} alt="" className="size-10 rounded object-contain" />
            ) : (
              <LogoMark className="size-8 text-muted-foreground/60" />
            )}
            <div>
              <p className="font-semibold">{seller.businessName ?? "Invoice"}</p>
              {seller.email && <p className="text-xs text-muted-foreground">{seller.email}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoice</p>
            <p className="font-mono text-lg font-semibold">{data.invoiceNumber}</p>
            <StatusStamp status={data.status} className="mt-1" />
          </div>
        </div>

        <div className="mt-8 grid grid-cols-2 gap-6 text-sm">
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">Bill to</p>
            <p className="font-medium">{client?.name ?? "—"}</p>
            {client?.company && <p className="text-muted-foreground">{client.company}</p>}
            {client?.billingAddress && (
              <p className="text-muted-foreground">
                {client.billingAddress.line1}, {client.billingAddress.city}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-muted-foreground">
              Issued {new Date(data.issueDate).toLocaleDateString()}
            </p>
            <p className="text-muted-foreground">Due {new Date(data.dueDate).toLocaleDateString()}</p>
          </div>
        </div>

        <div className="mt-8 overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">Price</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.lineItems.map((line, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-2">{line.description}</td>
                  <td className="px-3 py-2 text-right">{line.quantity}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {formatCents(line.unitPriceCents, data.currency)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    {formatCents(line.amountCents, data.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="ml-auto mt-4 flex max-w-xs flex-col gap-1 text-sm">
          <div className="flex justify-between text-muted-foreground">
            <span>Subtotal</span>
            <span className="font-mono tabular-nums">{formatCents(data.subtotalCents, data.currency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Tax</span>
            <span className="font-mono tabular-nums">{formatCents(data.taxCents, data.currency)}</span>
          </div>
          {data.discountCents > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>Discount</span>
              <span className="font-mono tabular-nums">-{formatCents(data.discountCents, data.currency)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-border pt-1 text-base font-semibold">
            <span>Total</span>
            <span className="font-mono tabular-nums">{formatCents(data.totalCents, data.currency)}</span>
          </div>
          {data.paidCents > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>Balance due</span>
              <span className="font-mono tabular-nums">{formatCents(data.balanceCents, data.currency)}</span>
            </div>
          )}
        </div>

        {data.notes && (
          <div className="mt-6 border-t border-border pt-4 text-sm text-muted-foreground">
            <p className="whitespace-pre-wrap">{data.notes}</p>
          </div>
        )}
        {seller.footerNote && (
          <p className="mt-4 text-center text-xs text-muted-foreground">{seller.footerNote}</p>
        )}
      </div>

      <div className="mt-6 flex justify-center">
        <a href={`/api/public/invoices/${token}/pdf`} target="_blank" rel="noreferrer">
          <Button variant="outline">
            <Download />
            Download PDF
          </Button>
        </a>
      </div>
    </div>
  );
}
