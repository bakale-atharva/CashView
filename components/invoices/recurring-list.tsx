"use client";

import { useMutation, usePaginatedQuery } from "convex/react";
import { MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { describeError } from "@/lib/convex-error";
import { useFeature } from "@/lib/use-entitlements";
import { formatDate } from "@/lib/date";
import { UpgradePrompt } from "@/components/dashboard/upgrade-prompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyRow, LoadMoreButton, SkeletonRows } from "@/components/app-shell/table-states";

const FREQUENCY_LABEL: Record<string, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

export function RecurringList() {
  const hasRecurring = useFeature("recurring_invoices");
  const pause = useMutation(api.recurring.pause);
  const resume = useMutation(api.recurring.resume);
  const remove = useMutation(api.recurring.remove);
  const { results, status, loadMore } = usePaginatedQuery(
    api.recurring.list,
    hasRecurring ? {} : "skip",
    { initialNumItems: 25 },
  );

  if (hasRecurring === false) {
    return <UpgradePrompt feature="Recurring invoices" />;
  }

  const loading = hasRecurring === undefined || status === "LoadingFirstPage";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Recurring invoices</h1>
          <Link href="/app/invoices" className="text-sm text-muted-foreground hover:underline">
            Back to invoices
          </Link>
        </div>
        <Link href="/app/invoices/recurring/new">
          <Button>
            <Plus />
            New template
          </Button>
        </Link>
      </div>

      <p className="max-w-2xl text-sm text-muted-foreground">
        A due template creates a <em>draft</em> invoice for you to review and send — nothing goes out
        automatically.
      </p>

      <div className="rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Frequency</TableHead>
              <TableHead>Next run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <SkeletonRows count={3} colSpan={5} />}
            {!loading && results.length === 0 && (
              <EmptyRow colSpan={5}>
                No recurring templates yet.
              </EmptyRow>
            )}
            {results.map((template) => (
              <TableRow key={template._id}>
                <TableCell>
                  <Link
                    href={`/app/invoices/recurring/${template._id}`}
                    className="font-medium hover:underline"
                  >
                    {template.clientName ?? "—"}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {FREQUENCY_LABEL[template.frequency]}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(template.nextRunAt)}
                </TableCell>
                <TableCell>
                  {template.isActive ? (
                    <Badge variant="secondary">Active</Badge>
                  ) : (
                    <Badge variant="outline">Paused</Badge>
                  )}
                  {template.lastError && (
                    <span className="ml-2 text-xs text-destructive">{template.lastError}</span>
                  )}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
                      <MoreHorizontal />
                      <span className="sr-only">Actions</span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {template.isActive ? (
                        <DropdownMenuItem
                          onClick={() =>
                            pause({ id: template._id }).catch((e) => toast.error(describeError(e)))
                          }
                        >
                          Pause
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onClick={() =>
                            resume({ id: template._id }).catch((e) => toast.error(describeError(e)))
                          }
                        >
                          Resume
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() =>
                          remove({ id: template._id })
                            .then(() => toast.success("Template deleted"))
                            .catch((e) => toast.error(describeError(e)))
                        }
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <LoadMoreButton status={status} onLoadMore={() => loadMore(25)} />
    </div>
  );
}
