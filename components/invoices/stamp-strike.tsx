"use client";

import { AnimatePresence, motion } from "motion/react";
import { StatusStamp } from "./status-stamp";
import type { InvoiceStatus } from "./status-stamp";

/**
 * The Certified Ledger's signature moment (PLAN.md A5): marking an invoice
 * Sent, Paid or Void plays the stamp striking the page once, keyed by status
 * so it fires only on an actual transition — never on a list render or a
 * page reload of the same status.
 */
export function StampStrike({ status }: { status: InvoiceStatus }) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={status}
        initial={{ opacity: 0, scale: 2.4 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 22, mass: 0.6 }}
        className="inline-block"
      >
        <StatusStamp status={status} className="text-base" />
      </motion.div>
    </AnimatePresence>
  );
}
