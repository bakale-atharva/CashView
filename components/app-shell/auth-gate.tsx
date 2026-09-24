"use client";

import { useConvexAuth } from "convex/react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Holds page content back until Convex has the Clerk token. Scoped queries
 * refuse anonymous callers, so rendering earlier makes every `useQuery` on the
 * page throw UNAUTHENTICATED during the brief window before auth resolves.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useConvexAuth();
  if (!isAuthenticated) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  return <>{children}</>;
}
