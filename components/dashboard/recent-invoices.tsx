"use client";

import { useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { formatCents } from "@/lib/money";
import { StatusStamp } from "@/components/invoices/status-stamp";
import { Skeleton } from "@/components/ui/skeleton";

export function RecentInvoices() {
  const result = useQuery(api.invoices.list, { paginationOpts: { numItems: 6, cursor: null } });

  if (result === undefined) {
    return (
      <div className="space-y-3">
        {["a", "b", "c"].map((key) => (
          <Skeleton key={key} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (result.page.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No invoices yet.{" "}
        <Link href="/app/invoices" className="underline underline-offset-2">
          Create your first one
        </Link>
        .
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {result.page.map((invoice) => (
        <li key={invoice._id}>
          <Link
            href={`/app/invoices/${invoice._id}`}
            className="flex items-center justify-between gap-4 py-2.5 text-sm hover:bg-muted/50"
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="font-mono text-xs text-muted-foreground">
                {invoice.invoiceNumber}
              </span>
              <span className="truncate text-foreground/80">
                {invoice.clientName ?? "—"}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-3">
              <span className="font-mono tabular-nums">
                {formatCents(invoice.totalCents, invoice.currency)}
              </span>
              <StatusStamp status={invoice.status} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
