import { auth } from "@clerk/nextjs/server";
import type { Id } from "@/convex/_generated/dataModel";
import { InvoiceForm } from "@/components/invoices/invoice-form";

export default async function EditInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await auth.protect();
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Edit draft</h1>
      <InvoiceForm invoiceId={id as Id<"invoices">} />
    </div>
  );
}
