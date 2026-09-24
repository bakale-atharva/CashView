"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useFeature } from "@/lib/use-entitlements";
import { PieChart } from "@/components/charts/pie-chart";
import { PieSlice } from "@/components/charts/pie-slice";
import { formatCents } from "@/lib/money";
import { UpgradePrompt } from "./upgrade-prompt";

const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
const OTHER_COLOR = "var(--muted-foreground)";
// One color per visible slice, never recycled: a repeated color across
// unrelated categories reads as one category split in two.
const MAX_SLICES = PALETTE.length;

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

  const top = breakdown.categories.slice(0, MAX_SLICES);
  const rest = breakdown.categories.slice(MAX_SLICES);
  const otherCents = rest.reduce((s, c) => s + c.totalCents, 0);

  const rows = [
    ...top.map((c, i) => ({ key: c.categoryId, name: c.name, cents: c.totalCents, color: PALETTE[i] })),
    ...(rest.length > 0
      ? [{ key: "other", name: `Other (${rest.length})`, cents: otherCents, color: OTHER_COLOR }]
      : []),
  ];

  return (
    <div className="flex items-start gap-4">
      <div className="shrink-0">
        <PieChart data={rows.map((r) => ({ label: r.name, value: r.cents, color: r.color }))} size={140} innerRadius={42} padAngle={0.02} cornerRadius={3}>
          {rows.map((r, i) => (
            <PieSlice key={r.key} index={i} />
          ))}
        </PieChart>
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5 text-sm">
        {rows.map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: r.color }} aria-hidden />
              <span className="truncate text-foreground/80">{r.name}</span>
            </span>
            <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
              {formatCents(r.cents, breakdown.currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
