"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
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
import { Textarea } from "@/components/ui/textarea";

type FormState = {
  name: string;
  company: string;
  email: string;
  phone: string;
  currency: string;
  notes: string;
};

function emptyForm(client?: Doc<"clients">): FormState {
  return {
    name: client?.name ?? "",
    company: client?.company ?? "",
    email: client?.email ?? "",
    phone: client?.phone ?? "",
    currency: client?.currency ?? "",
    notes: client?.notes ?? "",
  };
}

export function ClientFormDialog({
  client,
  open,
  onOpenChange,
  onSaved,
}: {
  /** Omit to create a new client. */
  client?: Doc<"clients">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (id: string) => void;
}) {
  const [form, setForm] = useState<FormState>(() => emptyForm(client));
  const { submitting, run } = useSubmit();
  const create = useMutation(api.clients.create);
  const update = useMutation(api.clients.update);
  const isEdit = client !== undefined;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const input = {
      name: form.name,
      company: form.company || undefined,
      email: form.email || undefined,
      phone: form.phone || undefined,
      currency: form.currency || undefined,
      notes: form.notes || undefined,
    };
    await run(async () => {
      if (isEdit) {
        await update({ id: client._id, ...input });
        toast.success("Client updated");
        onSaved?.(client._id);
      } else {
        const id = await create(input);
        toast.success("Client added");
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
        if (!next) setForm(emptyForm(client));
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? "Edit client" : "New client"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="client-name">Name</Label>
              <Input
                id="client-name"
                required
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="client-company">Company</Label>
              <Input
                id="client-company"
                value={form.company}
                onChange={(e) => set("company", e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor="client-email">Email</Label>
                <Input
                  id="client-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="client-phone">Phone</Label>
                <Input
                  id="client-phone"
                  value={form.phone}
                  onChange={(e) => set("phone", e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="client-currency">Currency</Label>
              <Input
                id="client-currency"
                placeholder="Defaults to your workspace currency"
                maxLength={3}
                value={form.currency}
                onChange={(e) => set("currency", e.target.value.toUpperCase())}
                disabled={isEdit}
              />
              {isEdit && (
                <p className="text-xs text-muted-foreground">
                  A client&rsquo;s currency locks once they have an invoice.
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="client-notes">Notes</Label>
              <Textarea
                id="client-notes"
                rows={3}
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {isEdit ? "Save changes" : "Add client"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
