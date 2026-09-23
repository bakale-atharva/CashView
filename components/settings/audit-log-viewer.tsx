"use client";

import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const ACTION_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  create: "secondary",
  update: "default",
  delete: "destructive",
};

/** Every write in this scope's books, newest first. Owners and admins only. */
export function AuditLogViewer() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.audit.listAuditLog,
    {},
    { initialNumItems: 50 },
  );
  const loading = status === "LoadingFirstPage";

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>What</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              ["a", "b", "c"].map((key) => (
                <TableRow key={key}>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {!loading && results.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  Nothing recorded yet.
                </TableCell>
              </TableRow>
            )}
            {results.map((entry) => (
              <TableRow key={entry._id}>
                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {new Date(entry._creationTime).toLocaleString()}
                </TableCell>
                <TableCell className="text-sm">
                  <div>{entry.actorEmail ?? entry.actorUserId}</div>
                  <div className="text-xs text-muted-foreground">{entry.actorRole}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={ACTION_VARIANT[entry.action] ?? "default"}>{entry.action}</Badge>
                </TableCell>
                <TableCell className="text-sm">
                  <div>{entry.summary}</div>
                  <div className="text-xs text-muted-foreground">
                    {entry.entityTable} · {entry.entityLabel}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {status === "CanLoadMore" && (
        <button
          type="button"
          onClick={() => loadMore(50)}
          className="self-center text-sm text-muted-foreground hover:underline"
        >
          Load more
        </button>
      )}
    </div>
  );
}
