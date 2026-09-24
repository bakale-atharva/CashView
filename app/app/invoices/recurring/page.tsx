import { auth } from "@clerk/nextjs/server";
import { RecurringList } from "@/components/invoices/recurring-list";

export default async function RecurringInvoicesPage() {
  await auth.protect();
  return <RecurringList />;
}
