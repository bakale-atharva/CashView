import { useQuery } from "convex/react";
import type { OptionalRestArgsOrSkip } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import type { Feature } from "@/convex/lib/entitlements";
import { useFeature } from "@/lib/use-entitlements";

/**
 * A query behind a plan feature. The backend gates it too, so it is skipped
 * entirely rather than left to throw UPGRADE_REQUIRED when the plan lacks
 * the feature. `allowed` is `undefined` while entitlements load.
 */
export function useGatedQuery<Query extends FunctionReference<"query">>(
  feature: Feature,
  query: Query,
  args: FunctionArgs<Query>,
): { allowed: boolean | undefined; data: FunctionReturnType<Query> | undefined } {
  const allowed = useFeature(feature);
  const data = useQuery(query, ...([allowed ? args : "skip"] as OptionalRestArgsOrSkip<Query>));
  return { allowed, data };
}
