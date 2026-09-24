"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useFeature } from "@/lib/use-entitlements";
import { Bar } from "@/components/charts/bar";
import { BarChart } from "@/components/charts/bar-chart";
import { Grid } from "@/components/charts/grid";
import { XAxis } from "@/components/charts/x-axis";
import { ChartTooltip } from "@/components/charts/tooltip";
import { UpgradePrompt } from "./upgrade-prompt";

export function CashFlowChart({
  from,
  to,
  granularity = "month",
}: {
  from: number;
  to: number;
  granularity?: "month" | "quarter" | "year";
}) {
  const hasReports = useFeature("reports");
  const cashFlow = useQuery(api.reports.cashFlow, hasReports ? { from, to, granularity } : "skip");

  if (hasReports === false) {
    return <UpgradePrompt feature="Cash flow" />;
  }

  // See RevenueChart: the built-in loading skeleton always keys its
  // synthetic points "date", so real data is remapped to match.
  const data = cashFlow?.series.map((row) => ({ ...row, date: row.start })) ?? [];

  return (
    <BarChart data={data} status={cashFlow === undefined ? "loading" : "ready"}>
      <Grid horizontal />
      <Bar dataKey="inCents" fill="var(--stamp-paid)" />
      <Bar dataKey="outCents" fill="var(--stamp-overdue)" />
      <XAxis />
      <ChartTooltip />
    </BarChart>
  );
}
