import { cn } from "@/lib/utils";

/**
 * The "Stamped C" mark from the Certified Ledger direction
 * (.impeccable/surfaces/app.md) — a rubber-stamp arc struck at an angle.
 * currentColor-driven so callers set the ink via text color.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-6 w-6", className)}
      aria-hidden="true"
    >
      <g fill="currentColor" transform="rotate(-8 16 16)">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M25.19 23.72 A12 12 0 1 1 25.19 8.28 L20.60 12.14 A6 6 0 1 0 20.60 19.86 Z"
        />
      </g>
    </svg>
  );
}

/**
 * The full lockup: mark + wordmark. Use `LogoMark` alone wherever the
 * lockup would not fit (collapsed sidebar rail, favicon-scale contexts).
 */
export function Logo({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-current",
        className
      )}
    >
      <LogoMark className={cn("h-6 w-6 text-primary", markClassName)} />
      <span className="text-lg font-semibold tracking-tight">CashView</span>
    </span>
  );
}
