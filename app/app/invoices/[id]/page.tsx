import { auth } from "@clerk/nextjs/server";
import type { Id } from "@/convex/_generated/dataModel";
import { InvoiceDetail } from "@/components/invoices/invoice-detail";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await auth.protect();
  const { id } = await params;
  return <InvoiceDetail invoiceId={id as Id<"invoices">} />;
}
