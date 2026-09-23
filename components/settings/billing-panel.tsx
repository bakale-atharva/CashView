"use client";

import { PricingTable } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useEntitlements } from "@/lib/use-entitlements";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PLAN_LABEL } from "./plan-copy";

/**
 * Switch the active workspace's plan. Organizations get the `*_org` plans,
 * a personal account the `*_user` ones — Clerk's PricingTable picks the set
 * from `for`. Checkout happens in Clerk; the billing webhook then updates the
 * `subscriptions` table, and every entitlement in the app (this page's badge
 * included) follows reactively.
 */
export function BillingPanel() {
  const { isAuthenticated } = useConvexAuth();
  const me = useQuery(api.me.getCurrentScope, isAuthenticated ? {} : "skip");
  const summary = useEntitlements();

  if (me === undefined || summary === undefined) {
    return <Skeleton className="h-80 w-full" />;
  }

  const isOrg = me.scopeKind === "org";
  const canManage = me.capabilities.includes("billing.manage");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">
          Current plan for this {isOrg ? "organization" : "personal account"}
        </span>
        <Badge variant="secondary">{PLAN_LABEL[summary.plan]}</Badge>
      </div>

      {canManage ? (
        <>
          {/* Keyed by scope so switching workspaces remounts it on the right payer. */}
          <PricingTable
            key={me.scopeId}
            for={isOrg ? "organization" : "user"}
            newSubscriptionRedirectUrl="/app/settings/billing"
          />
          <p className="text-xs text-muted-foreground">
            A plan change reaches CashView through Clerk&rsquo;s billing webhook, usually within a
            few seconds; the badge above updates on its own once it lands.
          </p>
        </>
      ) : (
        <p className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
          Only this organization&rsquo;s owner can change its plan. You&rsquo;re signed in with the{" "}
          <span className="font-medium text-foreground">{me.role}</span> role.
        </p>
      )}
    </div>
  );
}
