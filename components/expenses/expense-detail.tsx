"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { MoreHorizontal, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { describeError } from "@/lib/convex-error";
import { formatCents } from "@/lib/money";
import { useFeature } from "@/lib/use-entitlements";
import { formatDate } from "@/lib/date";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ExpenseFormDialog } from "./expense-form-dialog";
import { ReceiptDropzone } from "./receipt-dropzone";

/**
 * Receipts can be an image or a PDF (convex/lib/receipts.ts); the API returns
 * a bare URL with no content type, so this renders the image and falls back
 * to a plain link if the browser can't decode it as one (i.e. it's a PDF).
 */
function ReceiptPreview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block p-4 text-sm underline">
        Open the receipt
      </a>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived Convex storage URL
    <img src={url} alt="Receipt" className="max-h-96 w-full object-contain" onError={() => setFailed(true)} />
  );
}

function ScanSuggestion({ expenseId }: { expenseId: Id<"expenses"> }) {
  const data = useQuery(api.expenses.get, { id: expenseId });
  const applyScan = useMutation(api.receiptScan.applyScan);
  const dismissScan = useMutation(api.receiptScan.dismissScan);
  const suggestion = data?.expense.ocrSuggestion;
  if (!suggestion) return null;

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
      <p className="mb-2 flex items-center gap-1.5 font-medium">
        <Sparkles className="size-4" />
        Scanned from the receipt
      </p>
      <dl className="mb-3 grid grid-cols-2 gap-1 text-muted-foreground">
        {suggestion.vendor && (
          <>
            <dt>Vendor</dt>
            <dd className="text-foreground">{suggestion.vendor}</dd>
          </>
        )}
        {suggestion.amountCents !== undefined && (
          <>
            <dt>Amount</dt>
            <dd className="text-foreground">
              {formatCents(suggestion.amountCents, suggestion.currency ?? data.expense.currency)}
            </dd>
          </>
        )}
        {suggestion.spentAt !== undefined && (
          <>
            <dt>Date</dt>
            <dd className="text-foreground">{formatDate(suggestion.spentAt)}</dd>
          </>
        )}
      </dl>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() =>
            applyScan({ id: expenseId })
              .then(() => toast.success("Applied"))
              .catch((e) => toast.error(describeError(e)))
          }
        >
          Use these values
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => dismissScan({ id: expenseId })}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

export function ExpenseDetail({ expenseId }: { expenseId: Id<"expenses"> }) {
  const router = useRouter();
  const data = useQuery(api.expenses.get, { id: expenseId });
  const remove = useMutation(api.expenses.remove);
  const detachReceipt = useMutation(api.expenses.detachReceipt);
  const scan = useAction(api.receiptScan.scan);
  const hasScanning = useFeature("receipt_scanning");
  const [editOpen, setEditOpen] = useState(false);
  const [scanning, setScanning] = useState(false);

  if (data === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const { expense, category, client, receiptUrl } = data;

  async function handleScan() {
    setScanning(true);
    try {
      const result = await scan({ id: expenseId });
      if (!result.ok) toast.error(result.reason);
      else toast.success("Receipt scanned");
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Link href="/app/expenses" className="text-sm text-muted-foreground hover:underline">
              Expenses
            </Link>
            <span className="text-sm text-muted-foreground">/</span>
            <h1 className="text-xl font-semibold tracking-tight">{expense.vendor}</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {category?.name ?? "Uncategorised"} · {formatDate(expense.spentAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setEditOpen(true)}>
            Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
              <MoreHorizontal />
              <span className="sr-only">More</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  remove({ id: expenseId })
                    .then(() => {
                      toast.success("Expense deleted");
                      router.push("/app/expenses");
                    })
                    .catch((e) => toast.error(describeError(e)))
                }
              >
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Amount</p>
          <p className="font-mono text-2xl font-semibold tabular-nums">
            {formatCents(expense.amountCents, expense.currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Tax</p>
          <p className="font-mono text-2xl font-semibold tabular-nums">
            {formatCents(expense.taxCents, expense.currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Payment method</p>
          <p className="text-lg font-medium">{expense.paymentMethod}</p>
        </div>
      </div>

      {expense.isBillable && (
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="secondary">Billable</Badge>
          {client && (
            <Link href={`/app/clients/${client._id}`} className="text-muted-foreground hover:underline">
              {client.name}
            </Link>
          )}
        </div>
      )}

      {expense.description && (
        <div className="rounded-lg border border-border p-4 text-sm">
          <p className="mb-2 font-medium">Description</p>
          <p className="whitespace-pre-wrap text-muted-foreground">{expense.description}</p>
        </div>
      )}

      <div>
        <h2 className="mb-3 text-sm font-semibold">Receipt</h2>
        {receiptUrl ? (
          <div className="flex flex-col gap-3">
            <div className="overflow-hidden rounded-lg border border-border">
              <ReceiptPreview url={receiptUrl} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasScanning ? (
                <Button type="button" variant="outline" size="sm" onClick={handleScan} disabled={scanning}>
                  <Sparkles />
                  {scanning ? "Scanning…" : "Scan with AI"}
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  Receipt scanning is a Business feature.
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => detachReceipt({ id: expenseId }).catch((e) => toast.error(describeError(e)))}
              >
                Remove receipt
              </Button>
            </div>
            <ScanSuggestion expenseId={expenseId} />
          </div>
        ) : (
          <ReceiptDropzone expenseId={expenseId} />
        )}
      </div>

      <ExpenseFormDialog expense={expense} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  );
}
