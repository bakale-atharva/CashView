import { auth } from "@clerk/nextjs/server";
import { InvoiceForm } from "@/components/invoices/invoice-form";

export default async function NewInvoicePage() {
  await auth.protect();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">New invoice</h1>
      <InvoiceForm />
    </div>
  );
}
