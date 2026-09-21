import type { PlanKey } from "./validators";

/**
 * Clerk plan slugs. The `_org` / `_user` suffix keeps the two plan families
 * apart: personal scope is a workspace that upgrades on its own.
 */
const PLAN_KEY_BY_SLUG: Record<string, PlanKey> = {
  free_org: "free",
  pro_org: "pro",
  business_org: "business",
  free_user: "free",
  pro_user: "pro",
  business_user: "business",
};

/** Null for a slug we don't recognise; callers skip it rather than guess. */
export function planKeyFromSlug(slug: string): PlanKey | null {
  return Object.hasOwn(PLAN_KEY_BY_SLUG, slug) ? PLAN_KEY_BY_SLUG[slug] : null;
}
