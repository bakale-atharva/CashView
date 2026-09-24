import { auth } from "@clerk/nextjs/server";
import { InvoiceList } from "@/components/invoices/invoice-list";

export default async function InvoicesPage() {
  await auth.protect();
  return <InvoiceList />;
}
