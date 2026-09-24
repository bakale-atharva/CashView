import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatDate } from "@/lib/date";
import { formatCents } from "@/lib/money";

/**
 * Server-only (Node runtime route handlers, see app/api/**\/pdf). Never
 * imported from a "use client" component: @react-pdf/renderer renders to a
 * buffer, not the DOM.
 *
 * The shape both PDF routes normalize into — one from `invoices.get` (the
 * owner's authenticated download) and one from `public.getInvoiceByToken`
 * (the client's link) — so this component has exactly one rendering to keep
 * in sync with the on-screen invoice.
 */
export type InvoicePdfAddress = {
  line1: string;
  line2?: string | null;
  city: string;
  region?: string | null;
  postalCode?: string | null;
  country: string;
};

export type InvoicePdfData = {
  invoiceNumber: string;
  status: string;
  issueDate: number;
  dueDate: number;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  notes: string | null;
  lineItems: {
    description: string;
    quantity: number;
    unitPriceCents: number;
    taxRatePct: number;
    amountCents: number;
  }[];
  client: { name: string; company: string | null; billingAddress: InvoicePdfAddress | null } | null;
  seller: {
    businessName: string | null;
    address: InvoicePdfAddress | null;
    email: string | null;
    phone: string | null;
    taxId: string | null;
    footerNote: string | null;
  };
};

function addressLines(address: InvoicePdfAddress | null | undefined): string[] {
  if (!address) return [];
  const cityLine = [address.city, address.region, address.postalCode].filter(Boolean).join(", ");
  return [address.line1, address.line2, cityLine, address.country].filter(
    (line): line is string => Boolean(line),
  );
}

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#111" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  businessName: { fontSize: 14, fontWeight: 700 },
  muted: { color: "#666" },
  invoiceLabel: { fontSize: 9, textTransform: "uppercase", letterSpacing: 1, color: "#666" },
  invoiceNumber: { fontSize: 14, fontWeight: 700 },
  statusBadge: {
    marginTop: 4,
    alignSelf: "flex-end",
    borderWidth: 1,
    borderColor: "#111",
    paddingVertical: 2,
    paddingHorizontal: 6,
    fontSize: 8,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  addressRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 20 },
  addressBlock: { width: "45%" },
  addressLabel: { fontSize: 8, textTransform: "uppercase", letterSpacing: 1, color: "#666", marginBottom: 4 },
  table: { borderWidth: 1, borderColor: "#ddd", marginBottom: 16 },
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: "#f5f5f5",
    borderBottomWidth: 1,
    borderColor: "#ddd",
    paddingVertical: 6,
  },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: "#eee", paddingVertical: 6 },
  colDescription: { width: "46%", paddingHorizontal: 6 },
  colQty: { width: "12%", paddingHorizontal: 6, textAlign: "right" },
  colPrice: { width: "18%", paddingHorizontal: 6, textAlign: "right" },
  colTax: { width: "10%", paddingHorizontal: 6, textAlign: "right" },
  colAmount: { width: "14%", paddingHorizontal: 6, textAlign: "right" },
  totals: { alignSelf: "flex-end", width: "45%", marginBottom: 20 },
  totalsRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  totalsFinal: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderColor: "#111",
    paddingTop: 4,
    marginTop: 4,
    fontWeight: 700,
  },
  notes: { marginTop: 12, color: "#444" },
  footer: { marginTop: 30, textAlign: "center", fontSize: 8, color: "#999" },
});

export function InvoicePdfDocument({ data }: { data: InvoicePdfData }) {
  const sellerAddress = addressLines(data.seller.address);
  const clientAddress = addressLines(data.client?.billingAddress);

  return (
    <Document title={`Invoice ${data.invoiceNumber}`}>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.businessName}>{data.seller.businessName ?? "Invoice"}</Text>
            {sellerAddress.map((line) => (
              <Text key={line} style={styles.muted}>
                {line}
              </Text>
            ))}
            {data.seller.email && <Text style={styles.muted}>{data.seller.email}</Text>}
            {data.seller.phone && <Text style={styles.muted}>{data.seller.phone}</Text>}
            {data.seller.taxId && <Text style={styles.muted}>Tax ID {data.seller.taxId}</Text>}
          </View>
          <View>
            <Text style={styles.invoiceLabel}>Invoice</Text>
            <Text style={styles.invoiceNumber}>{data.invoiceNumber}</Text>
            <Text style={styles.statusBadge}>{data.status}</Text>
          </View>
        </View>

        <View style={styles.addressRow}>
          <View style={styles.addressBlock}>
            <Text style={styles.addressLabel}>Bill to</Text>
            <Text>{data.client?.name ?? "—"}</Text>
            {data.client?.company && <Text style={styles.muted}>{data.client.company}</Text>}
            {clientAddress.map((line) => (
              <Text key={line} style={styles.muted}>
                {line}
              </Text>
            ))}
          </View>
          <View style={[styles.addressBlock, { alignItems: "flex-end" }]}>
            <Text style={styles.muted}>Issued {formatDate(data.issueDate)}</Text>
            <Text style={styles.muted}>Due {formatDate(data.dueDate)}</Text>
          </View>
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={styles.colDescription}>Description</Text>
            <Text style={styles.colQty}>Qty</Text>
            <Text style={styles.colPrice}>Unit price</Text>
            <Text style={styles.colTax}>Tax</Text>
            <Text style={styles.colAmount}>Amount</Text>
          </View>
          {data.lineItems.map((line, i) => (
            <View key={i} style={styles.tableRow}>
              <Text style={styles.colDescription}>{line.description}</Text>
              <Text style={styles.colQty}>{line.quantity}</Text>
              <Text style={styles.colPrice}>{formatCents(line.unitPriceCents, data.currency)}</Text>
              <Text style={styles.colTax}>{line.taxRatePct}%</Text>
              <Text style={styles.colAmount}>{formatCents(line.amountCents, data.currency)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totals}>
          <View style={styles.totalsRow}>
            <Text style={styles.muted}>Subtotal</Text>
            <Text>{formatCents(data.subtotalCents, data.currency)}</Text>
          </View>
          <View style={styles.totalsRow}>
            <Text style={styles.muted}>Tax</Text>
            <Text>{formatCents(data.taxCents, data.currency)}</Text>
          </View>
          {data.discountCents > 0 && (
            <View style={styles.totalsRow}>
              <Text style={styles.muted}>Discount</Text>
              <Text>-{formatCents(data.discountCents, data.currency)}</Text>
            </View>
          )}
          <View style={styles.totalsFinal}>
            <Text>Total</Text>
            <Text>{formatCents(data.totalCents, data.currency)}</Text>
          </View>
          {data.paidCents > 0 && (
            <View style={styles.totalsRow}>
              <Text style={styles.muted}>Balance due</Text>
              <Text>{formatCents(data.balanceCents, data.currency)}</Text>
            </View>
          )}
        </View>

        {data.notes && <Text style={styles.notes}>{data.notes}</Text>}
        {data.seller.footerNote && <Text style={styles.footer}>{data.seller.footerNote}</Text>}
      </Page>
    </Document>
  );
}
