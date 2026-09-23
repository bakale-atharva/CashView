"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useFeature } from "@/lib/use-entitlements";
import { PieChart } from "@/components/charts/pie-chart";
import { formatCents } from "@/lib/money";
import { UpgradePrompt } from "./upgrade-prompt";

const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function ExpenseBreakdownChart({ from, to }: { from: number; to: number }) {
  const hasReports = useFeature("reports");
  const breakdown = useQuery(api.reports.expenseBreakdown, hasReports ? { from, to } : "skip");

  if (hasReports === false) {
    return <UpgradePrompt feature="Expense breakdown" />;
  }

  if (breakdown === undefined) {
    return <div className="aspect-square w-full max-w-[220px] animate-pulse rounded-full bg-muted" />;
  }

  if (breakdown.categories.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No expenses logged in this range yet.
      </p>
    );
  }

  const slices = breakdown.categories.map((c, i) => ({
    label: c.name,
    value: c.totalCents,
    color: PALETTE[i % PALETTE.length],
  }));

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      <PieChart data={slices} size={180} innerRadius={55} padAngle={0.02} cornerRadius={3}>
        <></>
      </PieChart>
      <ul className="w-full space-y-1.5 text-sm">
        {breakdown.categories.map((c, i) => (
          <li key={c.categoryId} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 truncate">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ background: PALETTE[i % PALETTE.length] }}
                aria-hidden
              />
              <span className="truncate text-foreground/80">{c.name}</span>
            </span>
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
              {formatCents(c.totalCents, breakdown.currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
