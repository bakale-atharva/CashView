"use client";

import { OrganizationProfile } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Team management and invitations for the active organization, via Clerk's
 * own UI. A personal account has no roster to manage — Clerk's component
 * would throw without an active organization, so this checks first rather
 * than letting that reach the user as an error (the same rule that produced
 * app/error.tsx's org-switch retry earlier in the build).
 */
export function TeamPanel() {
  const { isAuthenticated } = useConvexAuth();
  const me = useQuery(api.me.getCurrentScope, isAuthenticated ? {} : "skip");

  if (me === undefined) {
    return <Skeleton className="h-96 w-full" />;
  }

  if (me.scopeKind !== "org") {
    return (
      <p className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
        Personal accounts don&rsquo;t have a team to manage. Switch to an organization from the top
        bar to invite people and manage roles.
      </p>
    );
  }

  return (
    <div className="flex justify-center">
      <OrganizationProfile routing="hash" />
    </div>
  );
}
