"use client";

import { useState } from "react";
import { useFeature } from "@/lib/use-entitlements";
import { useMonthRange } from "@/lib/use-month-range";
import { CashFlowChart } from "@/components/dashboard/cash-flow-chart";
import { ExpenseBreakdownChart } from "@/components/dashboard/expense-breakdown-chart";
import { RevenueChart } from "@/components/dashboard/revenue-chart";
import { UpgradePrompt } from "@/components/dashboard/upgrade-prompt";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCard } from "@/components/app-shell/section-card";
import { ProfitLossReport } from "./profit-loss-report";
import { ReceivablesReport } from "./receivables-report";

export type Granularity = "month" | "quarter" | "year";

const RANGES = [
  { label: "Last 3 months", months: 3 },
  { label: "Last 6 months", months: 6 },
  { label: "Last 12 months", months: 12 },
] as const;

export function ReportsView() {
  const hasReports = useFeature("reports");
  const [months, setMonths] = useState<number>(6);
  const [granularity, setGranularity] = useState<Granularity>("month");

  const { from, to } = useMonthRange(months);

  if (hasReports === false) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        <UpgradePrompt feature="Reports" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
        <div className="flex gap-2">
          <Select value={String(months)} onValueChange={(v) => setMonths(Number(v))}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => (
                <SelectItem key={r.months} value={String(r.months)}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={granularity} onValueChange={(v) => setGranularity(v as Granularity)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="month">Monthly</SelectItem>
              <SelectItem value="quarter">Quarterly</SelectItem>
              <SelectItem value="year">Yearly</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <SectionCard title="Receivables">
        <ReceivablesReport from={from} to={to} />
      </SectionCard>

      <SectionCard title="Revenue">
        <RevenueChart from={from} to={to} granularity={granularity} />
      </SectionCard>

      <SectionCard title="Profit & loss">
        <ProfitLossReport from={from} to={to} granularity={granularity} />
      </SectionCard>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Expense breakdown">
          <ExpenseBreakdownChart from={from} to={to} />
        </SectionCard>
        <SectionCard title="Cash flow">
          <CashFlowChart from={from} to={to} granularity={granularity} />
        </SectionCard>
      </div>
    </div>
  );
}
