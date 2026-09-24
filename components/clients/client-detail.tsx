"use client";

import { usePaginatedQuery, useQuery } from "convex/react";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/date";
import { StatusStamp } from "@/components/invoices/status-stamp";
import { Badge } from "@/components/ui/badge";
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
import { ClientFormDialog } from "./client-form-dialog";

export function ClientDetail({ clientId }: { clientId: Id<"clients"> }) {
  const client = useQuery(api.clients.get, { id: clientId });
  const [editOpen, setEditOpen] = useState(false);
  const { results: invoices, status } = usePaginatedQuery(
    api.clients.listInvoices,
    { clientId },
    { initialNumItems: 20 },
  );

  if (client === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/app/clients" className="text-sm text-muted-foreground hover:underline">
              Clients
            </Link>
            <span className="text-sm text-muted-foreground">/</span>
            <h1 className="text-xl font-semibold tracking-tight">{client.name}</h1>
            {client.isArchived && <Badge variant="secondary">Archived</Badge>}
          </div>
          {client.company && <p className="text-sm text-muted-foreground">{client.company}</p>}
        </div>
        <Button variant="outline" onClick={() => setEditOpen(true)}>
          Edit
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Outstanding</p>
          <p className="font-mono text-2xl font-semibold tabular-nums">
            {formatCents(client.outstandingCents, client.currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Total billed</p>
          <p className="font-mono text-2xl font-semibold tabular-nums">
            {formatCents(client.totalBilledCents, client.currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Total paid</p>
          <p className="font-mono text-2xl font-semibold tabular-nums">
            {formatCents(client.totalPaidCents, client.currency)}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border p-4 text-sm">
          <p className="mb-2 font-medium">Contact</p>
          <dl className="space-y-1 text-muted-foreground">
            <div>{client.email ?? "No email on file"}</div>
            <div>{client.phone ?? "No phone on file"}</div>
          </dl>
        </div>
        {client.notes && (
          <div className="rounded-lg border border-border p-4 text-sm">
            <p className="mb-2 font-medium">Notes</p>
            <p className="whitespace-pre-wrap text-muted-foreground">{client.notes}</p>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold">Invoice history</h2>
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Invoice</TableHead>
                <TableHead>Issued</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status === "LoadingFirstPage" &&
                ["a", "b", "c"].map((key) => (
                  <TableRow key={key}>
                    <TableCell colSpan={4}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {status !== "LoadingFirstPage" && invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                    No invoices yet.
                  </TableCell>
                </TableRow>
              )}
              {invoices.map((invoice) => (
                <TableRow key={invoice._id}>
                  <TableCell>
                    <Link href={`/app/invoices/${invoice._id}`} className="hover:underline">
                      {invoice.invoiceNumber}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(invoice.issueDate)}
                  </TableCell>
                  <TableCell>
                    <StatusStamp status={invoice.status} />
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(invoice.totalCents - invoice.paidCents, invoice.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <ClientFormDialog client={client} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}
