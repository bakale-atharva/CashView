"use client";

import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { describeError } from "@/lib/convex-error";
import type { LineItemDraft } from "@/lib/invoice-totals";
import { emptyLineItem } from "@/lib/invoice-totals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { LineItemsEditor } from "./line-items-editor";

function dateToInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function inputToDate(value: string): number | undefined {
  if (!value) return undefined;
  const [y, m, d] = value.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function draftsFromLines(
  lines: readonly { description: string; quantity: number; unitPriceCents: number; taxRatePct: number }[],
): LineItemDraft[] {
  return lines.length === 0
    ? [emptyLineItem()]
    : lines.map((l) => ({
        description: l.description,
        quantity: String(l.quantity),
        unitPriceCents: String(l.unitPriceCents),
        taxRatePct: String(l.taxRatePct),
      }));
}

/** Create or edit a draft invoice. Only drafts are editable (convex/invoices.ts). */
export function InvoiceForm({ invoiceId }: { invoiceId?: Id<"invoices"> }) {
  const router = useRouter();
  const isEdit = invoiceId !== undefined;
  const existing = useQuery(api.invoices.get, isEdit ? { id: invoiceId } : "skip");
  const settings = useQuery(api.settings.get, {});
  const { results: clients } = usePaginatedQuery(
    api.clients.list,
    { archived: false },
    { initialNumItems: 200 },
  );
  const create = useMutation(api.invoices.create);
  const update = useMutation(api.invoices.update);

  const [clientId, setClientId] = useState<Id<"clients"> | undefined>();
  const [issueDate, setIssueDate] = useState<string>("");
  const [dueDate, setDueDate] = useState<string>("");
  const [exchangeRate, setExchangeRate] = useState("");
  const [notes, setNotes] = useState("");
  const [discountCents, setDiscountCents] = useState(0);
  const [lines, setLines] = useState<LineItemDraft[]>([emptyLineItem()]);
  const [hydrated, setHydrated] = useState(!isEdit);
  const [submitting, setSubmitting] = useState(false);

  if (isEdit && existing !== undefined && !hydrated) {
    const { invoice, lineItems } = existing;
    setClientId(invoice.clientId);
    setIssueDate(dateToInput(invoice.issueDate));
    setDueDate(dateToInput(invoice.dueDate));
    setExchangeRate(invoice.exchangeRate ? String(invoice.exchangeRate) : "");
    setNotes(invoice.notes ?? "");
    setDiscountCents(invoice.discountCents);
    setLines(draftsFromLines(lineItems));
    setHydrated(true);
  }

  const selectedClient: Doc<"clients"> | undefined = clients.find((c) => c._id === clientId);
  const needsExchangeRate =
    selectedClient !== undefined && settings !== undefined && selectedClient.currency !== settings.currency;

  if ((isEdit && existing === undefined) || settings === undefined || !hydrated) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isEdit && existing !== undefined && existing.invoice.status !== "draft") {
    return (
      <p className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
        Only draft invoices can be edited. This one has already been sent.
      </p>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (clientId === undefined) {
      toast.error("Choose a client");
      return;
    }
    const lineItems = lines.map((l) => ({
      description: l.description,
      quantity: Number(l.quantity),
      unitPriceCents: Math.round(Number(l.unitPriceCents)),
      taxRatePct: Number(l.taxRatePct),
    }));
    const rate = Number(exchangeRate);
    const input = {
      clientId,
      issueDate: inputToDate(issueDate),
      dueDate: inputToDate(dueDate),
      discountCents,
      exchangeRate: needsExchangeRate && Number.isFinite(rate) && rate > 0 ? rate : undefined,
      notes: notes || undefined,
      lineItems,
    };

    setSubmitting(true);
    try {
      let id: Id<"invoices">;
      if (isEdit) {
        await update({ id: invoiceId, ...input });
        id = invoiceId;
      } else {
        id = await create(input);
      }
      toast.success(isEdit ? "Draft updated" : "Draft created");
      router.push(`/app/invoices/${id}`);
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5 sm:col-span-1">
          <Label htmlFor="invoice-client">Client</Label>
          <Select
            value={clientId}
            onValueChange={(value) => setClientId(value as Id<"clients">)}
            disabled={isEdit}
          >
            <SelectTrigger id="invoice-client" className="w-full">
              <SelectValue placeholder="Choose a client" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((c) => (
                <SelectItem key={c._id} value={c._id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="invoice-issue-date">Issue date</Label>
          <Input
            id="invoice-issue-date"
            type="date"
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="invoice-due-date">Due date</Label>
          <Input
            id="invoice-due-date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
      </div>

      {needsExchangeRate && (
        <div className="grid max-w-xs gap-1.5">
          <Label htmlFor="invoice-rate">
            Exchange rate ({selectedClient!.currency} → {settings!.currency})
          </Label>
          <Input
            id="invoice-rate"
            inputMode="decimal"
            placeholder="1.00"
            value={exchangeRate}
            onChange={(e) => setExchangeRate(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            This client bills in {selectedClient!.currency}, a different currency from your workspace.
          </p>
        </div>
      )}

      <div>
        <Label className="mb-2 block">Line items</Label>
        <LineItemsEditor
          lines={lines}
          onChange={setLines}
          discountCents={discountCents}
          onDiscountChange={setDiscountCents}
          currency={selectedClient?.currency ?? settings?.currency ?? "USD"}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="invoice-notes">Notes</Label>
        <Textarea
          id="invoice-notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Payment instructions, thank-you note, terms…"
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {isEdit ? "Save draft" : "Create draft"}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
