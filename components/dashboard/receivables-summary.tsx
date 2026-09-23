"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { formatCents } from "@/lib/money";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The dashboard's one deliberate application of the direction contract's
 * "magnitude scales weight" raise (.impeccable/surfaces/app.md, from the
 * star-atlas challenger): the outstanding figure is the largest number on
 * the page because it is the number most worth noticing first.
 */
export function ReceivablesSummary({ from, to }: { from: number; to: number }) {
  // Read once per mount, not on every render: `asOf` only needs to be "now
  // enough" to bucket aging correctly, and Date.now() is impure during render.
  const [asOf] = useState(() => Date.now());
  const receivables = useQuery(api.reports.receivables, { from, to, asOf });

  if (receivables === undefined) {
    return (
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
        <Skeleton className="h-12 w-40" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-28" />
      </div>
    );
  }

  const { range, outstanding, currency } = receivables;

  return (
    <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
      <div>
        <p className="text-xs text-muted-foreground">Outstanding</p>
        <p className="font-mono text-4xl font-semibold tabular-nums tracking-tight">
          {formatCents(outstanding.totalCents, currency)}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Overdue</p>
        <p
          className="font-mono text-2xl font-semibold tabular-nums"
          style={{ color: outstanding.overdueCents > 0 ? "var(--stamp-overdue)" : undefined }}
        >
          {formatCents(outstanding.overdueCents, currency)}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Collected this range</p>
        <p className="font-mono text-2xl font-semibold tabular-nums">
          {formatCents(range.collectedCents, currency)}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">Collection rate</p>
        <p className="font-mono text-2xl font-semibold tabular-nums">
          {range.collectionRatePct}%
        </p>
      </div>
    </div>
  );
}
