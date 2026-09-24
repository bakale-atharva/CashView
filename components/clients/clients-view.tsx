"use client";

import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { MoreHorizontal, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { describeError } from "@/lib/convex-error";
import { formatCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyRow, LoadMoreButton, SkeletonRows } from "@/components/app-shell/table-states";
import { ClientFormDialog } from "./client-form-dialog";

const PAGE_SIZE = 25;

function ClientRowActions({ client }: { client: Doc<"clients"> }) {
  const archive = useMutation(api.clients.archive);
  const unarchive = useMutation(api.clients.unarchive);
  const remove = useMutation(api.clients.remove);
  const [editOpen, setEditOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
          <MoreHorizontal />
          <span className="sr-only">Actions</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditOpen(true)}>Edit</DropdownMenuItem>
          {client.isArchived ? (
            <DropdownMenuItem
              onClick={() =>
                unarchive({ id: client._id }).catch((e) => toast.error(describeError(e)))
              }
            >
              Unarchive
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              onClick={() =>
                archive({ id: client._id }).catch((e) => toast.error(describeError(e)))
              }
            >
              Archive
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            variant="destructive"
            onClick={() =>
              remove({ id: client._id })
                .then(() => toast.success("Client deleted"))
                .catch((e) => toast.error(describeError(e)))
            }
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ClientFormDialog client={client} open={editOpen} onOpenChange={setEditOpen} />
    </>
  );
}

export function ClientsView() {
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const summary = useQuery(api.clients.outstandingSummary, {});

  const { results, status, loadMore } = usePaginatedQuery(
    api.clients.list,
    { archived: showArchived, search: search.trim() || undefined },
    { initialNumItems: PAGE_SIZE },
  );

  const loading = status === "LoadingFirstPage";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Clients</h1>
          {summary && (
            <p className="text-sm text-muted-foreground">
              {summary.clientCount} active · {formatCents(summary.outstandingCents, summary.currency)}{" "}
              outstanding
            </p>
          )}
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus />
          New client
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search clients…"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          variant={showArchived ? "secondary" : "outline"}
          size="sm"
          onClick={() => setShowArchived((v) => !v)}
        >
          {showArchived ? "Showing archived" : "Show archived"}
        </Button>
      </div>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
              <TableHead className="text-right">Total billed</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <SkeletonRows count={5} colSpan={6} />}
            {!loading && results.length === 0 && (
              <EmptyRow colSpan={6}>
                {search
                  ? "No clients match that search."
                  : showArchived
                    ? "No archived clients."
                    : "No clients yet — add your first one to start invoicing."}
              </EmptyRow>
            )}
            {results.map((client) => (
              <TableRow key={client._id}>
                <TableCell>
                  <Link href={`/app/clients/${client._id}`} className="hover:underline">
                    <div className="font-medium">{client.name}</div>
                    {client.company && (
                      <div className="text-xs text-muted-foreground">{client.company}</div>
                    )}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {client.email ?? client.phone ?? "—"}
                </TableCell>
                <TableCell className="font-mono text-sm">{client.currency}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCents(client.outstandingCents, client.currency)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                  {formatCents(client.totalBilledCents, client.currency)}
                </TableCell>
                <TableCell>
                  <ClientRowActions client={client} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <LoadMoreButton status={status} onLoadMore={() => loadMore(PAGE_SIZE)} />

      <ClientFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
