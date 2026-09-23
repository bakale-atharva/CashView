"use client";

import { useOrganization } from "@clerk/nextjs";
import { Check, Lock } from "lucide-react";
import Link from "next/link";
import { useEntitlements } from "@/lib/use-entitlements";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { GATED_FEATURES, PLAN_LABEL } from "./plan-copy";

function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit === null ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const atCap = limit !== null && used >= limit;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span>{label}</span>
        <span className="font-mono tabular-nums text-muted-foreground">
          {used}
          {limit === null ? " · unlimited" : ` of ${limit}`}
        </span>
      </div>
      {limit !== null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full"
            style={{
              width: `${pct}%`,
              background: atCap ? "var(--stamp-overdue)" : "var(--primary)",
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Which workspace this is, what plan it's on, and how close it is to the caps. */
export function SettingsOverview() {
  const { organization, isLoaded } = useOrganization();
  const summary = useEntitlements();

  if (summary === undefined || !isLoaded) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">Workspace</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {organization ? "Organization" : "Personal account"} · plans apply per workspace
        </p>
        <div className="mt-4 flex items-center gap-3">
          <span className="text-lg font-semibold">{organization?.name ?? "Personal books"}</span>
          <Badge variant="secondary">{PLAN_LABEL[summary.plan]} plan</Badge>
        </div>
        <Link
          href="/app/settings/billing"
          className="mt-4 inline-block text-sm underline underline-offset-2"
        >
          Change plan
        </Link>
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold">Usage</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          Caps stop you adding more; they never hide what you already have.
        </p>
        <div className="space-y-4">
          <Meter label="Clients" used={summary.clients.used} limit={summary.clients.limit} />
          <Meter
            label="Invoices this month"
            used={summary.invoices.used}
            limit={summary.invoices.limit}
          />
          {organization && (
            <Meter label="Seats" used={summary.seats.used} limit={summary.seats.limit} />
          )}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-5 lg:col-span-2">
        <h2 className="text-sm font-semibold">Features</h2>
        <ul className="mt-3 divide-y divide-border">
          {GATED_FEATURES.map(({ feature, label, plan }) => {
            const included = summary.features.includes(feature);
            return (
              <li key={feature} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                <span className="flex items-center gap-2">
                  {included ? (
                    <Check className="size-4 text-primary" aria-hidden />
                  ) : (
                    <Lock className="size-4 text-muted-foreground" aria-hidden />
                  )}
                  <span className={included ? undefined : "text-muted-foreground"}>{label}</span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {included ? "Included" : `${PLAN_LABEL[plan]} and above`}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
