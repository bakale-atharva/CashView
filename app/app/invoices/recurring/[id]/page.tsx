import { auth } from "@clerk/nextjs/server";
import type { Id } from "@/convex/_generated/dataModel";
import { RecurringForm } from "@/components/invoices/recurring-form";

export default async function EditRecurringInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await auth.protect();
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Edit recurring template</h1>
      <RecurringForm templateId={id as Id<"recurringInvoices">} />
    </div>
  );
}
