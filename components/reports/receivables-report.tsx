"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { formatCents } from "@/lib/money";
import { Skeleton } from "@/components/ui/skeleton";

const BUCKET_LABEL: Record<string, string> = {
  current: "Current",
  "1-30": "1–30 days",
  "31-60": "31–60 days",
  "61-90": "61–90 days",
  "90+": "90+ days",
};

export function ReceivablesReport({ from, to }: { from: number; to: number }) {
  const [asOf] = useState(() => Date.now());
  const data = useQuery(api.reports.receivables, { from, to, asOf });

  if (data === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }

  const maxBucketCents = Math.max(1, ...data.outstanding.aging.map((b) => b.cents));

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Invoiced</p>
          <p className="font-mono text-xl font-semibold tabular-nums">
            {formatCents(data.range.invoicedCents, data.currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Collected</p>
          <p className="font-mono text-xl font-semibold tabular-nums">
            {formatCents(data.range.collectedCents, data.currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Collection rate</p>
          <p className="font-mono text-xl font-semibold tabular-nums">{data.range.collectionRatePct}%</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Outstanding now</p>
          <p className="font-mono text-xl font-semibold tabular-nums">
            {formatCents(data.outstanding.totalCents, data.currency)}
          </p>
        </div>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">Aging of what&rsquo;s outstanding</p>
        <div className="space-y-2">
          {data.outstanding.aging.map((bucket) => (
            <div key={bucket.bucket} className="flex items-center gap-3 text-sm">
              <span className="w-20 shrink-0 text-muted-foreground">{BUCKET_LABEL[bucket.bucket]}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(bucket.cents / maxBucketCents) * 100}%`,
                    background: bucket.bucket === "current" ? "var(--stamp-sent)" : "var(--stamp-overdue)",
                  }}
                />
              </div>
              <span className="w-24 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
                {formatCents(bucket.cents, data.currency)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
