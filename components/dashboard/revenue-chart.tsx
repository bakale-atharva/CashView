"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useFeature } from "@/lib/use-entitlements";
import { Grid } from "@/components/charts/grid";
import { LineChart, Line } from "@/components/charts/line-chart";
import { XAxis } from "@/components/charts/x-axis";
import { ChartTooltip } from "@/components/charts/tooltip";
import { UpgradePrompt } from "./upgrade-prompt";

export function RevenueChart({
  from,
  to,
  granularity = "month",
}: {
  from: number;
  to: number;
  granularity?: "month" | "quarter" | "year";
}) {
  const hasReports = useFeature("reports");
  // Gated on the backend (convex/reports.ts) behind the `reports` feature —
  // skip the query entirely rather than let it throw UPGRADE_REQUIRED.
  const revenue = useQuery(api.reports.revenue, hasReports ? { from, to, granularity } : "skip");

  if (hasReports === false) {
    return <UpgradePrompt feature="Revenue trends" />;
  }

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
