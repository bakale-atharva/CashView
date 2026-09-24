import { auth } from "@clerk/nextjs/server";
import { fetchQuery } from "convex/nextjs";
import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { InvoicePdfDocument } from "@/components/invoices/invoice-pdf-document";
import type { InvoicePdfData } from "@/components/invoices/invoice-pdf-document";

// @react-pdf/renderer renders with Node APIs; it cannot run on the edge runtime.
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { getToken } = await auth();
  const token = await getToken({ template: "convex" });
  if (!token) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const [invoiceData, settings] = await Promise.all([
    fetchQuery(api.invoices.get, { id: id as Id<"invoices"> }, { token }),
    fetchQuery(api.settings.get, {}, { token }),
  ]);

  const { invoice, client, lineItems, balanceCents } = invoiceData;
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
    balanceCents,
    notes: invoice.notes ?? null,
    lineItems,
    client: client
      ? { name: client.name, company: client.company ?? null, billingAddress: client.billingAddress ?? null }
      : null,
    seller: {
      businessName: settings.businessName ?? null,
      address: settings.address ?? null,
      email: settings.email ?? null,
      phone: settings.phone ?? null,
      taxId: settings.taxId ?? null,
      footerNote: settings.footerNote ?? null,
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
