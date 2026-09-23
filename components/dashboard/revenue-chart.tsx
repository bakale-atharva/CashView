"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Grid } from "@/components/charts/grid";
import { LineChart, Line } from "@/components/charts/line-chart";
import { XAxis } from "@/components/charts/x-axis";
import { ChartTooltip } from "@/components/charts/tooltip";

export function RevenueChart({ from, to }: { from: number; to: number }) {
  const revenue = useQuery(api.reports.revenue, { from, to, granularity: "month" });
  // The chart's built-in loading skeleton always keys its synthetic points
  // "date" (components/charts/generate-chart-skeleton-data.ts), so real data
  // uses that same key rather than a custom xDataKey the skeleton doesn't
  // know about.
  const data = revenue?.series.map((row) => ({ ...row, date: row.start })) ?? [];

  return (
    <LineChart
      data={data}
      status={revenue === undefined ? "loading" : "ready"}
      loadingLabel="Loading revenue…"
    >
      <Grid horizontal />
      <Line dataKey="invoicedCents" stroke="var(--chart-line-primary)" />
      <Line dataKey="collectedCents" stroke="var(--chart-line-secondary)" />
      <XAxis />
      <ChartTooltip />
    </LineChart>
  );
}
