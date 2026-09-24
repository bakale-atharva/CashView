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
import { StatTile } from "@/components/app-shell/stat-tile";

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
        <StatTile label="Revenue" size="md">
          {formatCents(data.revenueCents, data.currency)}
        </StatTile>
        <StatTile label="Expenses" size="md">
          {formatCents(data.expensesCents, data.currency)}
        </StatTile>
        <StatTile label={<>Net profit ({data.marginPct}% margin)</>} size="md">
          {formatCents(data.netProfitCents, data.currency)}
        </StatTile>
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
