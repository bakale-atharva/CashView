"use client";

import { useMutation, useQuery } from "convex/react";
import { Copy, Download, MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { describeError } from "@/lib/convex-error";
import { formatCents } from "@/lib/money";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { RecordPaymentDialog } from "./record-payment-dialog";
import { StampStrike } from "./stamp-strike";

export function InvoiceDetail({ invoiceId }: { invoiceId: Id<"invoices"> }) {
  const router = useRouter();
  const data = useQuery(api.invoices.get, { id: invoiceId });
  const send = useMutation(api.invoices.send);
  const voidInvoice = useMutation(api.invoices.voidInvoice);
  const removeInvoice = useMutation(api.invoices.remove);
  const deletePayment = useMutation(api.invoices.deletePayment);
  const [paymentOpen, setPaymentOpen] = useState(false);

  if (data === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { invoice, client, lineItems, payments, balanceCents } = data;
  const publicUrl =
    invoice.publicToken && typeof window !== "undefined"
      ? `${window.location.origin}/i/${invoice.publicToken}`
      : null;

  async function handleSend() {
    try {
      await send({ id: invoiceId });
      toast.success("Invoice sent — share its link with the client");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function handleVoid() {
    try {
      await voidInvoice({ id: invoiceId });
      toast.success("Invoice voided");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  async function handleDelete() {
    try {
      await removeInvoice({ id: invoiceId });
      toast.success("Draft deleted");
      router.push("/app/invoices");
    } catch (error) {
      toast.error(describeError(error));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Link href="/app/invoices" className="text-sm text-muted-foreground hover:underline">
                Invoices
              </Link>
              <span className="text-sm text-muted-foreground">/</span>
              <h1 className="text-xl font-semibold tracking-tight">{invoice.invoiceNumber}</h1>
            </div>
            {client && (
              <Link href={`/app/clients/${client._id}`} className="text-sm text-muted-foreground hover:underline">
                {client.name}
              </Link>
            )}
          </div>
          <StampStrike status={invoice.status} />
        </div>

        <div className="flex items-center gap-2">
          {invoice.status === "draft" && (
            <>
              <Button variant="outline" onClick={() => router.push(`/app/invoices/${invoiceId}/edit`)}>
                Edit
              </Button>
              <Button onClick={handleSend}>Send</Button>
            </>
          )}
          {(invoice.status === "sent" || invoice.status === "viewed" || invoice.status === "overdue") && (
            <Button onClick={() => setPaymentOpen(true)}>Record payment</Button>
          )}
          <a href={`/api/invoices/${invoiceId}/pdf`} target="_blank" rel="noreferrer">
            <Button variant="outline">
              <Download />
              PDF
            </Button>
          </a>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" />}>
              <MoreHorizontal />
              <span className="sr-only">More</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {invoice.status === "draft" && (
                <DropdownMenuItem variant="destructive" onClick={handleDelete}>
                  Delete draft
                </DropdownMenuItem>
              )}
              {["sent", "viewed", "overdue"].includes(invoice.status) && (
                <DropdownMenuItem variant="destructive" onClick={handleVoid}>
                  Void invoice
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {publicUrl && (
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(publicUrl).then(() => toast.success("Link copied"));
          }}
          className="flex w-fit items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <Copy className="size-3.5" />
          {publicUrl}
        </button>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Total</p>
          <p className="font-mono text-2xl font-semibold tabular-nums">
            {formatCents(invoice.totalCents, invoice.currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Paid</p>
          <p className="font-mono text-2xl font-semibold tabular-nums">
            {formatCents(invoice.paidCents, invoice.currency)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Balance</p>
          <p className="font-mono text-2xl font-semibold tabular-nums">
            {formatCents(balanceCents, invoice.currency)}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 text-sm text-muted-foreground">
        <div>Issued {new Date(invoice.issueDate).toLocaleDateString()}</div>
        <div>Due {new Date(invoice.dueDate).toLocaleDateString()}</div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold">Line items</h2>
        <div className="rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Tax</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lineItems.map((line) => (
                <TableRow key={line._id}>
                  <TableCell>{line.description}</TableCell>
                  <TableCell className="text-right">{line.quantity}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(line.unitPriceCents, invoice.currency)}
                  </TableCell>
                  <TableCell className="text-right">{line.taxRatePct}%</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(line.amountCents, invoice.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="ml-auto mt-3 flex max-w-xs flex-col gap-1 text-sm">
          <div className="flex justify-between text-muted-foreground">
            <span>Subtotal</span>
            <span className="font-mono tabular-nums">{formatCents(invoice.subtotalCents, invoice.currency)}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Tax</span>
            <span className="font-mono tabular-nums">{formatCents(invoice.taxCents, invoice.currency)}</span>
          </div>
          {invoice.discountCents > 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>Discount</span>
              <span className="font-mono tabular-nums">
                -{formatCents(invoice.discountCents, invoice.currency)}
              </span>
            </div>
          )}
          <div className="flex justify-between border-t border-border pt-1 font-semibold">
            <span>Total</span>
            <span className="font-mono tabular-nums">{formatCents(invoice.totalCents, invoice.currency)}</span>
          </div>
        </div>
      </div>

      {invoice.notes && (
        <div className="rounded-lg border border-border p-4 text-sm">
          <p className="mb-2 font-medium">Notes</p>
          <p className="whitespace-pre-wrap text-muted-foreground">{invoice.notes}</p>
        </div>
      )}

      {payments.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold">Payments</h2>
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((payment) => (
                  <TableRow key={payment._id}>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(payment.paidAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>{payment.method}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {payment.reference ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCents(payment.amountCents, invoice.currency)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() =>
                          deletePayment({ id: payment._id }).catch((e) => toast.error(describeError(e)))
                        }
                      >
                        <span className="sr-only">Remove payment</span>×
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <RecordPaymentDialog
        invoiceId={invoiceId}
        balanceCents={balanceCents}
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
      />
    </div>
  );
}
