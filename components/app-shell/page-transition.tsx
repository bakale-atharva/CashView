"use client";

import { AnimatePresence, motion } from "motion/react";
import { usePathname } from "next/navigation";

/**
 * The app shell's one authored motion moment (see the plan's F1 note and
 * .impeccable/surfaces/app.md): the Next.js App Router does not animate
 * between routes on its own, so without this a click on a nav item is a hard
 * cut. A short fade + settle makes each route change read as a state change,
 * not a page reload — kept inside Operate mode's 150-250ms budget.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={pathname}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
