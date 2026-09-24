import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A titled card section, optionally with a one-line description. */
export function SectionCard({
  title,
  description,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("rounded-lg border border-border bg-card p-5", className)}>
      {description === undefined ? (
        <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      ) : (
        <>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mb-4 text-xs text-muted-foreground">{description}</p>
        </>
      )}
      {children}
    </section>
  );
}
