import { cn } from "@/lib/utils";

export type InvoiceStatus = "draft" | "sent" | "viewed" | "paid" | "overdue" | "void";

const STAMP: Record<InvoiceStatus, { label: string; color: string; struck?: boolean }> = {
  draft: { label: "Draft", color: "var(--stamp-draft)" },
  sent: { label: "Sent", color: "var(--stamp-sent)" },
  viewed: { label: "Viewed", color: "var(--stamp-sent)" },
  paid: { label: "Paid", color: "var(--stamp-paid)" },
  overdue: { label: "Overdue", color: "var(--stamp-overdue)" },
  void: { label: "Void", color: "var(--stamp-void)", struck: true },
};

/**
 * The status vocabulary of the Certified Ledger direction
 * (.impeccable/surfaces/app.md): a struck ink mark, one committed color per
 * state, always paired with its word — never color or shape alone. Static
 * here; the animated "strike" plays only at the moment a status actually
 * changes (Phase F4), never on every render of a list.
 */
export function StatusStamp({ status, className }: { status: InvoiceStatus; className?: string }) {
  const meta = STAMP[status];
  return (
    <span
      className={cn(
        "inline-flex -rotate-3 items-center rounded-[3px] border-2 px-1.5 py-0.5 text-[0.7rem] font-bold uppercase tracking-[0.08em]",
        meta.struck && "line-through decoration-2",
        className,
      )}
      style={{ borderColor: meta.color, color: meta.color }}
    >
      {meta.label}
    </span>
  );
}
