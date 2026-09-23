import { fetchQuery } from "convex/nextjs";
import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { InvoicePdfDocument } from "@/components/invoices/invoice-pdf-document";
import type { InvoicePdfData } from "@/components/invoices/invoice-pdf-document";

// @react-pdf/renderer renders with Node APIs; it cannot run on the edge runtime.
export const runtime = "nodejs";

/**
 * The public link's PDF. Unauthenticated on purpose, exactly like
 * convex/public.ts: the token itself is the only capability check.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invoice = await fetchQuery(api.public.getInvoiceByToken, { token });
  if (invoice === null) {
    return NextResponse.json({ error: "This invoice link is no longer available." }, { status: 404 });
  }

  const data: InvoicePdfData = {
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    subtotalCents: invoice.subtotalCents,
    taxCents: invoice.taxCents,
    discountCents: invoice.discountCents,
    totalCents: invoice.totalCents,
    paidCents: invoice.paidCents,
    balanceCents: invoice.balanceCents,
    notes: invoice.notes,
    lineItems: invoice.lineItems,
    client: invoice.client,
    seller: {
      businessName: invoice.seller.businessName,
      address: invoice.seller.address,
      email: invoice.seller.email,
      phone: invoice.seller.phone,
      taxId: invoice.seller.taxId,
      footerNote: invoice.seller.footerNote,
    },
  };

  const buffer = await renderToBuffer(<InvoicePdfDocument data={data} />);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${invoice.invoiceNumber}.pdf"`,
    },
  });
}
