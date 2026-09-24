"use client";

import { useMutation, useQuery } from "convex/react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { describeError } from "@/lib/convex-error";
import { useSubmit } from "@/lib/use-submit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

type Settings = Doc<"scopeSettings"> & { logoUrl: string | null };

type FormState = {
  businessName: string;
  email: string;
  phone: string;
  taxId: string;
  line1: string;
  city: string;
  country: string;
  currency: string;
  defaultTaxRatePct: string;
  invoiceNumberPrefix: string;
  paymentTermsDays: string;
  footerNote: string;
};

function toForm(s: Settings): FormState {
  return {
    businessName: s.businessName ?? "",
    email: s.email ?? "",
    phone: s.phone ?? "",
    taxId: s.taxId ?? "",
    line1: s.address?.line1 ?? "",
    city: s.address?.city ?? "",
    country: s.address?.country ?? "",
    currency: s.currency,
    defaultTaxRatePct: String(s.defaultTaxRatePct),
    invoiceNumberPrefix: s.invoiceNumberPrefix,
    paymentTermsDays: String(s.paymentTermsDays),
    footerNote: s.footerNote ?? "",
  };
}

/** Business identity, branding and invoice defaults. Owners and admins only. */
export function BrandingForm() {
  const settings = useQuery(api.settings.get, {});
  const update = useMutation(api.settings.update);
  const generateLogoUploadUrl = useMutation(api.settings.generateLogoUploadUrl);
  const attachLogo = useMutation(api.settings.attachLogo);
  const removeLogo = useMutation(api.settings.removeLogo);

  const [form, setForm] = useState<FormState | null>(null);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const { submitting, run } = useSubmit();
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (settings !== undefined && hydratedFor !== settings._id) {
    setForm(toForm(settings));
    setHydratedFor(settings._id);
  }

  if (settings === undefined || form === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    await run(async () => {
      await update({
        businessName: form.businessName || undefined,
        address:
          form.line1 && form.city && form.country
            ? { line1: form.line1, city: form.city, country: form.country }
            : undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
        taxId: form.taxId || undefined,
        currency: form.currency,
        defaultTaxRatePct: Number(form.defaultTaxRatePct),
        invoiceNumberPrefix: form.invoiceNumberPrefix,
        paymentTermsDays: Number(form.paymentTermsDays),
        footerNote: form.footerNote || undefined,
      });
      toast.success("Settings saved");
    });
  }

  async function handleLogoChange(file: File) {
    setUploadingLogo(true);
    try {
      const postUrl = await generateLogoUploadUrl();
      const response = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error("Upload failed. Try again.");
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      await attachLogo({ storageId });
      toast.success("Logo updated");
    } catch (error) {
      toast.error(describeError(error));
    } finally {
      setUploadingLogo(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-8">
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Logo</h2>
        <div className="flex items-center gap-4">
          {settings.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived Convex storage URL
            <img src={settings.logoUrl} alt="Business logo" className="size-16 rounded object-contain" />
          ) : (
            <div className="flex size-16 items-center justify-center rounded border border-dashed border-border text-xs text-muted-foreground">
              No logo
            </div>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploadingLogo}
              onClick={() => fileRef.current?.click()}
            >
              {uploadingLogo ? "Uploading…" : "Upload logo"}
            </Button>
            {settings.logoUrl && (
              <Button type="button" variant="ghost" size="sm" onClick={() => removeLogo()}>
                Remove
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleLogoChange(file);
              e.target.value = "";
            }}
          />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Business identity</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="brand-name">Business name</Label>
            <Input id="brand-name" value={form.businessName} onChange={(e) => set("businessName", e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brand-tax-id">Tax ID</Label>
            <Input id="brand-tax-id" value={form.taxId} onChange={(e) => set("taxId", e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brand-email">Email</Label>
            <Input id="brand-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brand-phone">Phone</Label>
            <Input id="brand-phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="brand-line1">Street address</Label>
            <Input id="brand-line1" value={form.line1} onChange={(e) => set("line1", e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brand-city">City</Label>
            <Input id="brand-city" value={form.city} onChange={(e) => set("city", e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brand-country">Country</Label>
            <Input id="brand-country" value={form.country} onChange={(e) => set("country", e.target.value)} />
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Invoice defaults</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="brand-currency">Currency</Label>
            <Input
              id="brand-currency"
              maxLength={3}
              value={form.currency}
              onChange={(e) => set("currency", e.target.value.toUpperCase())}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brand-prefix">Invoice number prefix</Label>
            <Input
              id="brand-prefix"
              value={form.invoiceNumberPrefix}
              onChange={(e) => set("invoiceNumberPrefix", e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brand-tax-rate">Default tax rate (%)</Label>
            <Input
              id="brand-tax-rate"
              inputMode="decimal"
              value={form.defaultTaxRatePct}
              onChange={(e) => set("defaultTaxRatePct", e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="brand-terms">Payment terms (days)</Label>
            <Input
              id="brand-terms"
              inputMode="numeric"
              value={form.paymentTermsDays}
              onChange={(e) => set("paymentTermsDays", e.target.value)}
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="brand-footer">Invoice footer note</Label>
            <Textarea
              id="brand-footer"
              rows={2}
              value={form.footerNote}
              onChange={(e) => set("footerNote", e.target.value)}
              placeholder="Thank you for your business!"
            />
          </div>
        </div>
      </section>

      <Button type="submit" disabled={submitting} className="self-start">
        Save changes
      </Button>
    </form>
  );
}
