"use client";

import { usePaginatedQuery } from "convex/react";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { formatCents } from "@/lib/money";
import { StatusStamp } from "@/components/invoices/status-stamp";
import type { InvoiceStatus } from "@/components/invoices/status-stamp";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 25;

const TABS: { label: string; status?: InvoiceStatus }[] = [
  { label: "All" },
  { label: "Draft", status: "draft" },
  { label: "Sent", status: "sent" },
  { label: "Overdue", status: "overdue" },
  { label: "Paid", status: "paid" },
  { label: "Void", status: "void" },
];

export function InvoiceList() {
  const [status, setStatus] = useState<InvoiceStatus | undefined>();
  const { results, status: loadStatus, loadMore } = usePaginatedQuery(
    api.invoices.list,
    { status },
    { initialNumItems: PAGE_SIZE },
  );
  const loading = loadStatus === "LoadingFirstPage";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Invoices</h1>
          <Link href="/app/invoices/recurring" className="text-sm text-muted-foreground hover:underline">
            Manage recurring invoices
          </Link>
        </div>
        <Link href="/app/invoices/new">
          <Button>
            <Plus />
            New invoice
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tab) => {
          const active = tab.status === status;
          return (
            <button
              key={tab.label}
              type="button"
              onClick={() => setStatus(tab.status)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
                active
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Due</TableHead>
              <TableHead className="text-right">Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              ["a", "b", "c", "d", "e"].map((key) => (
                <TableRow key={key}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {!loading && results.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  {status ? "No invoices with this status." : "No invoices yet — create your first one."}
                </TableCell>
              </TableRow>
            )}
            {results.map((invoice) => (
              <TableRow key={invoice._id}>
                <TableCell>
                  <Link href={`/app/invoices/${invoice._id}`} className="font-medium hover:underline">
                    {invoice.invoiceNumber}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{invoice.clientName ?? "—"}</TableCell>
                <TableCell>
                  <StatusStamp status={invoice.status} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(invoice.dueDate).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCents(invoice.balanceCents, invoice.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {loadStatus === "CanLoadMore" && (
        <Button variant="outline" onClick={() => loadMore(PAGE_SIZE)} className="self-center">
          Load more
        </Button>
      )}
    </div>
  );
}
