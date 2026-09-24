import { auth } from "@clerk/nextjs/server";
import { RecurringForm } from "@/components/invoices/recurring-form";

export default async function NewRecurringInvoicePage() {
  await auth.protect();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">New recurring template</h1>
      <RecurringForm />
    </div>
  );
}
