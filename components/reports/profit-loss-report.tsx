"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { formatCents } from "@/lib/money";
import type { Granularity } from "@/components/reports/reports-view";
import { Bar } from "@/components/charts/bar";
import { BarChart } from "@/components/charts/bar-chart";
import { ChartTooltip } from "@/components/charts/tooltip";
import { Grid } from "@/components/charts/grid";
import { BarXAxis } from "@/components/charts/bar-x-axis";
import { Skeleton } from "@/components/ui/skeleton";

export function ProfitLossReport({
  from,
  to,
  granularity,
}: {
  from: number;
  to: number;
  granularity: Granularity;
}) {
  const data = useQuery(api.reports.profitAndLoss, { from, to, granularity });

  if (data === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }

  const series = data.series.map((row) => ({ ...row, date: row.period }));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Revenue</p>
          <p className="font-mono text-xl font-semibold tabular-nums">
            {formatCents(data.revenueCents, data.currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Expenses</p>
          <p className="font-mono text-xl font-semibold tabular-nums">
            {formatCents(data.expensesCents, data.currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Net profit ({data.marginPct}% margin)</p>
          <p className="font-mono text-xl font-semibold tabular-nums">
            {formatCents(data.netProfitCents, data.currency)}
          </p>
        </div>
      </div>
      <BarChart data={series} xDataKey="date" status="ready">
        <Grid horizontal />
        <Bar dataKey="revenueCents" fill="var(--chart-line-primary)" />
        <Bar dataKey="expensesCents" fill="var(--stamp-overdue)" />
        <BarXAxis />
        <ChartTooltip />
      </BarChart>
    </div>
  );
}
