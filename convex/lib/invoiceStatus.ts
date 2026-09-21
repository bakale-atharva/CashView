import { ConvexError } from "convex/values";
import { startOfUtcDay } from "./invoiceMath";
import type { InvoiceStatus } from "./validators";

/**
 * The invoice lifecycle.
 *
 *   draft -> sent -> viewed -> paid
 *                \-> overdue -/
 *   sent | viewed | overdue -> void          (terminal)
 *
 * `overdue` is derived, not chosen: a daily job marks open invoices whose due
 * day has passed. `paid` is derived from the payments: it is reached when they
 * cover the total, and left again if a payment is removed. Everything else
 * goes through one of the explicit actions (send, void).
 */
const TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ["sent"],
  sent: ["viewed", "paid", "overdue", "void"],
  viewed: ["paid", "overdue", "void"],
  overdue: ["paid", "void"],
  // Back to an open state only when a payment is removed.
  paid: ["sent", "viewed", "overdue"],
  void: [],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (!canTransition(from, to)) {
    throw new ConvexError({ code: "INVALID_TRANSITION", from, to });
  }
}

/** Statuses in which a payment can still be recorded. */
export const PAYABLE: readonly InvoiceStatus[] = ["sent", "viewed", "overdue"];

/** An invoice is overdue once its whole due day is behind us. */
export function isPastDue(dueDate: number, now: number): boolean {
  return dueDate < startOfUtcDay(now);
}

type Payable = {
  status: InvoiceStatus;
  totalCents: number;
  paidCents: number;
  dueDate: number;
  viewedAt?: number;
};

/**
 * The status an invoice should have once its payments have changed, or null
 * if it should stay as it is. Drafts and voided invoices never move: nothing
 * can be owed on the first, and nothing is owed on the second.
 */
export function statusAfterPaymentChange(
  invoice: Payable,
  now: number,
): InvoiceStatus | null {
  if (invoice.status === "draft" || invoice.status === "void") return null;

  const settled = invoice.totalCents > 0 && invoice.paidCents >= invoice.totalCents;
  if (settled) return invoice.status === "paid" ? null : "paid";

  // A partial payment leaves the invoice where it was; only a paid invoice
  // that is no longer covered has to be reopened.
  if (invoice.status !== "paid") return null;
  if (isPastDue(invoice.dueDate, now)) return "overdue";
  return invoice.viewedAt !== undefined ? "viewed" : "sent";
}
