"use client";

import { ConvexError } from "convex/values";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/**
 * Catches errors thrown while rendering app/app/layout.tsx and everything
 * inside it (error.js can't catch a same-segment layout's own errors, so
 * this lives one level up — see Next.js's error-boundary docs).
 *
 * Convex's useQuery re-throws a server ConvexError during render so it can
 * be caught here. Switching Clerk organizations briefly invalidates the
 * current session token while a new one (scoped to the new org) is minted;
 * a query that happens to fire in that window gets a real, correctly
 * rejected UNAUTHENTICATED response, not a bug in the query itself. Retry
 * automatically rather than showing a dead end — Convex's subscription
 * re-runs the query the moment the refreshed token lands, typically within
 * a few hundred milliseconds.
 */
export default function AppSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const attempts = useRef(0);
  const isTransientAuthBlip =
    error instanceof ConvexError &&
    typeof error.data === "object" &&
    error.data !== null &&
    (error.data as { code?: unknown }).code === "UNAUTHENTICATED";

  useEffect(() => {
    if (!isTransientAuthBlip || attempts.current >= 5) return;
    attempts.current += 1;
    const timer = setTimeout(reset, 250 * attempts.current);
    return () => clearTimeout(timer);
  }, [isTransientAuthBlip, reset, error]);

  if (isTransientAuthBlip) {
    return (
      <div className="flex flex-1 items-center justify-center p-10">
        <p className="text-sm text-muted-foreground">Switching workspace…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-10 text-center">
      <p className="text-sm font-medium">Something went wrong.</p>
      <p className="max-w-sm text-sm text-muted-foreground">{error.message}</p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
