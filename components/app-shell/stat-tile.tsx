import type { ReactNode } from "react";

const VALUE_CLASS = {
  md: "font-mono text-xl font-semibold tabular-nums",
  lg: "font-mono text-2xl font-semibold tabular-nums",
} as const;

/** One headline figure in a card: a small label over a large value. */
export function StatTile({
  label,
  children,
  size = "lg",
  valueClassName,
}: {
  label: ReactNode;
  children: ReactNode;
  /** `md` for report summaries, `lg` for detail-page headers. */
  size?: keyof typeof VALUE_CLASS;
  /** Replaces the monospace figure styling, for a value that isn't a number. */
  valueClassName?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={valueClassName ?? VALUE_CLASS[size]}>{children}</p>
    </div>
  );
}
