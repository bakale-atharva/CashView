import Link from "next/link";
import type { ReactNode } from "react";

/**
 * A detail page's title line: a link back to its list, then the record's
 * name. `children` sit after the title (e.g. a status badge).
 */
export function BackBreadcrumb({
  href,
  label,
  title,
  children,
}: {
  href: string;
  label: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <Link href={href} className="text-sm text-muted-foreground hover:underline">
        {label}
      </Link>
      <span className="text-sm text-muted-foreground">/</span>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}
