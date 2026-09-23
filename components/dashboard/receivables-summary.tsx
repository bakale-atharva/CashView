"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { formatCents } from "@/lib/money";
import { useFeature } from "@/lib/use-entitlements";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The dashboard's one deliberate application of the direction contract's
 * "magnitude scales weight" raise (.impeccable/surfaces/app.md, from the
 * star-atlas challenger): the outstanding figure is the largest number on
 * the page because it is the number most worth noticing first.
 *
 * "Outstanding" always reads from clients.outstandingSummary — ungated, per
 * the plan's "caps stop you adding more, they never lock you out of what
 * you have." Overdue / collected-this-range / collection-rate come from
 * reports.receivables, which the backend gates behind the `reports`
 * feature (Pro+): those three are skipped rather than queried on Free, so
 * a Free-tier scope never throws UPGRADE_REQUIRED just for opening the
 * dashboard.
 */
export function ReceivablesSummary({ from, to }: { from: number; to: number }) {
  const hasReports = useFeature("reports");

  const live = useQuery(api.clients.outstandingSummary, {});
  // Read once per mount, not on every render: `asOf` only needs to be "now
  // enough" to bucket aging correctly, and Date.now() is impure during render.
  const [asOf] = useState(() => Date.now());
  const receivables = useQuery(api.reports.receivables, hasReports ? { from, to, asOf } : "skip");

  if (live === undefined || hasReports === undefined) {
    return (
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
        <Skeleton className="h-12 w-40" />
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-28" />
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
      <div>
        <p className="text-xs text-muted-foreground">Outstanding</p>
        <p className="font-mono text-4xl font-semibold tabular-nums tracking-tight">
          {formatCents(live.outstandingCents, live.currency)}
        </p>
      </div>
      {hasReports && receivables && (
        <>
          <div>
            <p className="text-xs text-muted-foreground">Overdue</p>
            <p
              className="font-mono text-2xl font-semibold tabular-nums"
              style={{
                color: receivables.outstanding.overdueCents > 0 ? "var(--stamp-overdue)" : undefined,
              }}
            >
              {formatCents(receivables.outstanding.overdueCents, receivables.currency)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Collected this range</p>
            <p className="font-mono text-2xl font-semibold tabular-nums">
              {formatCents(receivables.range.collectedCents, receivables.currency)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Collection rate</p>
            <p className="font-mono text-2xl font-semibold tabular-nums">
              {receivables.range.collectionRatePct}%
            </p>
          </div>
        </>
      )}
      {!hasReports && (
        <p className="max-w-[16rem] text-xs text-muted-foreground">
          Overdue tracking and collection rate are on Pro.
        </p>
      )}
    </div>
  );
}
