"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useFeature } from "@/lib/use-entitlements";
import { Bar } from "@/components/charts/bar";
import { BarChart } from "@/components/charts/bar-chart";
import { Grid } from "@/components/charts/grid";
import { BarXAxis } from "@/components/charts/bar-x-axis";
import { ChartTooltip } from "@/components/charts/tooltip";
import { UpgradePrompt } from "./upgrade-prompt";

const monthFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "2-digit",
  timeZone: "UTC",
});
const monthLabel = (ms: number) => monthFmt.format(ms);

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

  // BarChart reads its category from `xDataKey`; give each period a unique,
  // UTC-based label (a local-time Date would shift the day west of UTC).
  const data =
    cashFlow?.series.map((row) => ({
      ...row,
      date: granularity === "month" ? monthLabel(row.start) : row.period,
    })) ?? [];

  return (
    <BarChart data={data} xDataKey="date" status={cashFlow === undefined ? "loading" : "ready"}>
      <Grid horizontal />
      <Bar dataKey="inCents" fill="var(--stamp-paid)" />
      <Bar dataKey="outCents" fill="var(--stamp-overdue)" />
      <BarXAxis />
      <ChartTooltip />
    </BarChart>
  );
}
