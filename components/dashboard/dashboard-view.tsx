"use client";

import { useMonthRange } from "@/lib/use-month-range";
import { CashFlowChart } from "./cash-flow-chart";
import { ExpenseBreakdownChart } from "./expense-breakdown-chart";
import { ReceivablesSummary } from "./receivables-summary";
import { RecentInvoices } from "./recent-invoices";
import { RevenueChart } from "./revenue-chart";

export function DashboardView() {
  const { from, to } = useMonthRange(6);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <ReceivablesSummary from={from} to={to} />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-lg border border-border bg-card p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold">Revenue</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Invoiced vs. collected, last 6 months
          </p>
          <RevenueChart from={from} to={to} />
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">Where the money went</h2>
          <p className="mb-4 text-xs text-muted-foreground">Expenses by category</p>
          <ExpenseBreakdownChart from={from} to={to} />
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-lg border border-border bg-card p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold">Cash flow</h2>
          <p className="mb-4 text-xs text-muted-foreground">Money in vs. money out</p>
          <CashFlowChart from={from} to={to} />
        </section>

        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">Recent invoices</h2>
          <div className="mt-3">
            <RecentInvoices />
          </div>
        </section>
      </div>
    </div>
  );
}
