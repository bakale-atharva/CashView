"use client";

import { motion } from "motion/react";

const lines = [
  { label: "Website redesign — phase 2", qty: "1", amount: "$4,200.00" },
  { label: "Monthly hosting", qty: "3", amount: "$180.00" },
  { label: "Brand asset delivery", qty: "1", amount: "$650.00" },
];

/**
 * The one demonstration a competitor's screenshot can't reuse: an invoice
 * status as an actual struck ink mark, not a colored pill. This is the same
 * mark language as the app's status stamps (.impeccable/surfaces/app.md) —
 * the landing page proves the mechanism rather than describing it.
 */
export function InvoiceStampDemo() {
  return (
    <div className="relative w-full max-w-md rotate-1 rounded-xl border border-border bg-card p-6 shadow-[0_1px_0_var(--border)] sm:rotate-2">
      <div className="flex items-start justify-between border-b border-border pb-4">
        <div>
          <p className="text-sm font-semibold tracking-tight">INV-0142</p>
          <p className="text-xs text-muted-foreground">Atharva Bakale Industries</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-xs text-muted-foreground">Due Sep 30</p>
        </div>
      </div>

      <dl className="mt-4 space-y-2.5">
        {lines.map((line) => (
          <div key={line.label} className="flex items-baseline justify-between gap-4 text-sm">
            <dt className="truncate text-foreground/80">{line.label}</dt>
            <dd className="shrink-0 font-mono tabular-nums text-foreground">{line.amount}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 flex items-baseline justify-between border-t border-border pt-3">
        <span className="text-sm font-semibold">Total</span>
        <span className="font-mono text-base font-semibold tabular-nums">$5,030.00</span>
      </div>

      <motion.div
        aria-hidden
        initial={{ opacity: 0, scale: 1.6, rotate: -22 }}
        animate={{ opacity: 1, scale: 1, rotate: -10 }}
        transition={{ delay: 0.5, duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="pointer-events-none absolute right-6 top-16 select-none rounded-md border-[3px] px-3 py-1 text-lg font-bold tracking-[0.15em]"
        style={{
          borderColor: "var(--stamp-paid)",
          color: "var(--stamp-paid)",
        }}
      >
        PAID
      </motion.div>
    </div>
  );
}
