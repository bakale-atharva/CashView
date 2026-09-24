"use client";

import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { dateToInput } from "@/lib/date";
import { centsToInput, inputToCents } from "@/lib/money";
import { useSubmit } from "@/lib/use-submit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type FormState = {
  categoryId: Id<"expenseCategories"> | undefined;
  vendor: string;
  description: string;
  amount: string;
  tax: string;
  spentAt: string;
  paymentMethod: string;
  isBillable: boolean;
  clientId: Id<"clients"> | undefined;
};

function emptyForm(expense?: Doc<"expenses">): FormState {
  return {
    categoryId: expense?.categoryId,
    vendor: expense?.vendor ?? "",
    description: expense?.description ?? "",
    amount: expense ? centsToInput(expense.amountCents) : "",
    tax: expense && expense.taxCents > 0 ? centsToInput(expense.taxCents) : "",
    spentAt: dateToInput(expense ? expense.spentAt : Date.now()),
    paymentMethod: expense?.paymentMethod ?? "",
    isBillable: expense?.isBillable ?? false,
    clientId: expense?.clientId,
  };
}

export function ExpenseFormDialog({
  expense,
  open,
  onOpenChange,
  onSaved,
}: {
  /** Omit to create a new expense. */
  expense?: Doc<"expenses">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (id: string) => void;
}) {
  const [form, setForm] = useState<FormState>(() => emptyForm(expense));
  const { submitting, run } = useSubmit();
  const categories = useQuery(api.expenseCategories.list, {});
  const { results: clients } = usePaginatedQuery(
    api.clients.list,
    { archived: false },
    { initialNumItems: 200 },
  );
  const create = useMutation(api.expenses.create);
  const update = useMutation(api.expenses.update);
  const isEdit = expense !== undefined;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.categoryId === undefined) {
      toast.error("Choose a category");
      return;
    }
    const [y, m, d] = form.spentAt.split("-").map(Number);
    const input = {
      categoryId: form.categoryId,
      vendor: form.vendor,
      description: form.description || undefined,
      amountCents: inputToCents(form.amount),
      taxCents: form.tax ? inputToCents(form.tax) : undefined,
      spentAt: Date.UTC(y, m - 1, d),
      paymentMethod: form.paymentMethod,
      isBillable: form.isBillable,
      clientId: form.isBillable ? form.clientId : undefined,
    };

    await run(async () => {
      if (isEdit) {
        await update({ id: expense._id, ...input });
        toast.success("Expense updated");
        onSaved?.(expense._id);
      } else {
        const id = await create(input);
        toast.success("Expense added");
        setForm(emptyForm());
        onSaved?.(id);
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setForm(emptyForm(expense));
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit expense" : "New expense"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="expense-vendor">Vendor</Label>
                <Input
                  id="expense-vendor"
                  required
                  value={form.vendor}
                  onChange={(e) => set("vendor", e.target.value)}
                  autoFocus
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="expense-category">Category</Label>
                <Select
                  value={form.categoryId}
                  onValueChange={(value) => set("categoryId", value as Id<"expenseCategories">)}
                >
                  <SelectTrigger id="expense-category" className="w-full">
                    <SelectValue placeholder="Choose" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories?.map((c) => (
                      <SelectItem key={c._id} value={c._id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="expense-amount">Amount</Label>
                <Input
                  id="expense-amount"
                  inputMode="decimal"
                  required
                  value={form.amount}
                  onChange={(e) => set("amount", e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="expense-tax">Tax</Label>
                <Input
                  id="expense-tax"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={form.tax}
                  onChange={(e) => set("tax", e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="expense-date">Date</Label>
                <Input
                  id="expense-date"
                  type="date"
                  value={form.spentAt}
                  onChange={(e) => set("spentAt", e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="expense-method">Payment method</Label>
              <Input
                id="expense-method"
                required
                placeholder="Card, bank transfer, cash…"
                value={form.paymentMethod}
                onChange={(e) => set("paymentMethod", e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="expense-description">Description</Label>
              <Textarea
                id="expense-description"
                rows={2}
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </div>
            <label className="group/field-label flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.isBillable}
                onCheckedChange={(checked) => set("isBillable", checked === true)}
              />
              Billable to a client
            </label>
            {form.isBillable && (
              <div className="grid gap-1.5">
                <Label htmlFor="expense-client">Client</Label>
                <Select
                  value={form.clientId}
                  onValueChange={(value) => set("clientId", value as Id<"clients">)}
                >
                  <SelectTrigger id="expense-client" className="w-full">
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
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {isEdit ? "Save changes" : "Add expense"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
