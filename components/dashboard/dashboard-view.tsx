"use client";

import { useMonthRange } from "@/lib/use-month-range";
import { SectionCard } from "@/components/app-shell/section-card";
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
        <SectionCard
          title="Revenue"
          description="Invoiced vs. collected, last 6 months"
          className="lg:col-span-2"
        >
          <RevenueChart from={from} to={to} />
        </SectionCard>

        <SectionCard title="Where the money went" description="Expenses by category">
          <ExpenseBreakdownChart from={from} to={to} />
        </SectionCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <SectionCard
          title="Cash flow"
          description="Money in vs. money out"
          className="lg:col-span-2"
        >
          <CashFlowChart from={from} to={to} />
        </SectionCard>

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
