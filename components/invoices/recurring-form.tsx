"use client";

import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { LineItemDraft } from "@/lib/invoice-totals";
import { emptyLineItem } from "@/lib/invoice-totals";
import { dateToInput, inputToDate } from "@/lib/date";
import { useSubmit } from "@/lib/use-submit";
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

const FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
] as const;

export function RecurringForm({ templateId }: { templateId?: Id<"recurringInvoices"> }) {
  const router = useRouter();
  const isEdit = templateId !== undefined;
  const existing = useQuery(api.recurring.get, isEdit ? { id: templateId } : "skip");
  const { results: clients } = usePaginatedQuery(
    api.clients.list,
    { archived: false },
    { initialNumItems: 200 },
  );
  const create = useMutation(api.recurring.create);
  const update = useMutation(api.recurring.update);

  const [clientId, setClientId] = useState<Id<"clients"> | undefined>();
  const [frequency, setFrequency] = useState<(typeof FREQUENCIES)[number]["value"]>("monthly");
  const [startDate, setStartDate] = useState(() => dateToInput(Date.now()));
  const [endDate, setEndDate] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState("30");
  const [notes, setNotes] = useState("");
  const [discountCents, setDiscountCents] = useState(0);
  const [lines, setLines] = useState<LineItemDraft[]>([emptyLineItem()]);
  const [hydrated, setHydrated] = useState(!isEdit);
  const { submitting, run } = useSubmit();

  if (isEdit && existing !== undefined && !hydrated) {
    const { template, lineItems } = existing;
    setClientId(template.clientId);
    setFrequency(template.frequency);
    setStartDate(dateToInput(template.startDate));
    setEndDate(template.endDate ? dateToInput(template.endDate) : "");
    setPaymentTermsDays(String(template.paymentTermsDays));
    setNotes(template.notes ?? "");
    setDiscountCents(template.discountCents);
    setLines(
      lineItems.length === 0
        ? [emptyLineItem()]
        : lineItems.map((l) => ({
            description: l.description,
            quantity: String(l.quantity),
            unitPriceCents: String(l.unitPriceCents),
            taxRatePct: String(l.taxRatePct),
          })),
    );
    setHydrated(true);
  }

  if ((isEdit && existing === undefined) || !hydrated) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const selectedClient = clients.find((c) => c._id === clientId);

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
    const input = {
      clientId,
      frequency,
      startDate: inputToDate(startDate)!,
      endDate: inputToDate(endDate),
      paymentTermsDays: Number(paymentTermsDays),
      discountCents,
      notes: notes || undefined,
      lineItems,
    };

    await run(async () => {
      let id: Id<"recurringInvoices">;
      if (isEdit) {
        await update({ id: templateId, ...input });
        id = templateId;
      } else {
        id = await create(input);
      }
      toast.success(isEdit ? "Template updated" : "Template created");
      router.push(`/app/invoices/recurring/${id}`);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="recurring-client">Client</Label>
          <Select value={clientId} onValueChange={(value) => setClientId(value as Id<"clients">)}>
            <SelectTrigger id="recurring-client" className="w-full">
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
          <Label htmlFor="recurring-frequency">Frequency</Label>
          <Select value={frequency} onValueChange={(value) => setFrequency(value as typeof frequency)}>
            <SelectTrigger id="recurring-frequency" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FREQUENCIES.map((f) => (
                <SelectItem key={f.value} value={f.value}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="recurring-start">Start date</Label>
          <Input
            id="recurring-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="recurring-end">End date (optional)</Label>
          <Input id="recurring-end" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="recurring-terms">Payment terms (days)</Label>
          <Input
            id="recurring-terms"
            inputMode="numeric"
            value={paymentTermsDays}
            onChange={(e) => setPaymentTermsDays(e.target.value)}
          />
        </div>
      </div>

      <div>
        <Label className="mb-2 block">Line items</Label>
        <LineItemsEditor
          lines={lines}
          onChange={setLines}
          discountCents={discountCents}
          onDiscountChange={setDiscountCents}
          currency={selectedClient?.currency ?? "USD"}
        />
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="recurring-notes">Notes</Label>
        <Textarea id="recurring-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {isEdit ? "Save template" : "Create template"}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
