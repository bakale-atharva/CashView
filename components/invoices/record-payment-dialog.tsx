"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { centsToInput, inputToCents } from "@/lib/money";
import { useSubmit } from "@/lib/use-submit";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function RecordPaymentDialog({
  invoiceId,
  balanceCents,
  open,
  onOpenChange,
}: {
  invoiceId: Id<"invoices">;
  balanceCents: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const recordPayment = useMutation(api.invoices.recordPayment);
  const [amount, setAmount] = useState(() => centsToInput(balanceCents));
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const { submitting, run } = useSubmit();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      await recordPayment({
        invoiceId,
        amountCents: inputToCents(amount),
        method,
        reference: reference || undefined,
      });
      toast.success("Payment recorded");
      onOpenChange(false);
      setMethod("");
      setReference("");
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Record a payment</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="payment-amount">Amount</Label>
              <Input
                id="payment-amount"
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="payment-method">Method</Label>
              <Input
                id="payment-method"
                required
                placeholder="Bank transfer, card, cash…"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="payment-reference">Reference (optional)</Label>
              <Input
                id="payment-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              Record payment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
