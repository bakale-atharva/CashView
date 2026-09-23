import Link from "next/link";
import { LogoMark } from "@/components/brand/logo";

/**
 * What a locked feature looks like: a plain explanation of why and what
 * unlocks it, never a silently disabled control or a raw server error
 * (DESIGN.md's Do's and Don'ts — see the UPGRADE_REQUIRED case this
 * replaces, previously an uncaught crash to app/error.tsx).
 *
 * `requiredPlan` mirrors PLAN_LIMITS (convex/lib/entitlements.ts): reports
 * and recurring invoices unlock on Pro; receipt scanning and multi-currency
 * only on Business.
 */
export function UpgradePrompt({
  feature,
  requiredPlan = "Pro",
}: {
  feature: string;
  requiredPlan?: "Pro" | "Business";
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
      <LogoMark className="size-5 text-muted-foreground/40" />
      <p className="text-sm font-medium">
        {feature} is a {requiredPlan} feature
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Upgrade this workspace&rsquo;s plan to unlock it.
      </p>
      <Link href="/app/settings/billing" className="text-xs underline underline-offset-2">
        See plans
      </Link>
    </div>
  );
}
