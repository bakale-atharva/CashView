import { ConvexError } from "convex/values";
import type { Auth, UserIdentity } from "convex/server";
import type { Role, Scope } from "./validators";

/**
 * Who is asking, and on whose books. Derived from the verified JWT alone.
 *
 * Observed claim shape (measured against the dev Clerk instance, not assumed;
 * the org claim is nested, not flattened):
 *
 *   personal: { tokenIdentifier, issuer, subject, sid, sts, v: 2 }
 *   org:      { ...same, o: { id: "org_...", rol: "admin", slg: "acme-inc-..." } }
 *
 * `rol` arrives without Clerk's "org:" prefix. There is no email or name in
 * the token, and no `per` claim; Convex does not use Clerk permissions.
 */

export type Capability =
  | "clients.read"
  | "invoices.read"
  | "expenses.read"
  | "reports.read"
  | "clients.write"
  | "invoices.write"
  | "invoices.send"
  | "expenses.write"
  | "payments.record"
  | "settings.manage"
  | "members.manage"
  | "audit.read"
  | "billing.manage"
  | "org.delete"
  | "org.transferOwnership";

const READ: Capability[] = [
  "clients.read",
  "invoices.read",
  "expenses.read",
  "reports.read",
];
const WRITE: Capability[] = [
  "clients.write",
  "invoices.write",
  "invoices.send",
  "expenses.write",
  "payments.record",
];
const MANAGE: Capability[] = ["settings.manage", "members.manage", "audit.read"];
// The Owner/Admin split. Clerk withholds the matching permissions from Admin
// too, but Convex refuses these independently so a crafted request gets
// nowhere either.
const OWNER_ONLY: Capability[] = [
  "billing.manage",
  "org.delete",
  "org.transferOwnership",
];

const CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  owner: new Set([...READ, ...WRITE, ...MANAGE, ...OWNER_ONLY]),
  admin: new Set([...READ, ...WRITE, ...MANAGE]),
  accountant: new Set([...READ, ...WRITE]),
  viewer: new Set(READ),
};

const ROLES: readonly Role[] = ["owner", "admin", "accountant", "viewer"];

/**
 * Maps a Clerk role slug onto a capability role. Anything unrecognized,
 * including Clerk's built-in "member", falls back to viewer: least privilege
 * on the failure path.
 */
export function roleFromClerkSlug(slug: unknown): Role {
  if (typeof slug !== "string") return "viewer";
  const bare = slug.startsWith("org:") ? slug.slice("org:".length) : slug;
  return ROLES.find((role) => role === bare) ?? "viewer";
}

function unauthenticated(reason?: string): ConvexError<{
  code: "UNAUTHENTICATED";
  reason?: string;
}> {
  return new ConvexError({ code: "UNAUTHENTICATED", reason });
}

/** Pure: builds the Scope from an identity. Exported for tests. */
export function scopeFromIdentity(identity: UserIdentity): Scope {
  const userId = identity.subject;
  if (typeof userId !== "string" || userId === "") {
    throw unauthenticated("missing subject");
  }

  const org: unknown = identity.o;
  if (org === undefined || org === null) {
    // Personal scope: the user owns their books, so every capability is granted.
    return { scopeId: userId, scopeKind: "user", userId, role: "owner" };
  }

  // An org claim that is present but malformed must fail closed. Falling
  // through to personal scope would silently switch which data is shown.
  if (typeof org !== "object" || Array.isArray(org)) {
    throw unauthenticated("malformed org claim");
  }
  const { id, rol } = org as { id?: unknown; rol?: unknown };
  if (typeof id !== "string" || id === "") {
    throw unauthenticated("malformed org claim");
  }
  return {
    scopeId: id,
    scopeKind: "org",
    userId,
    role: roleFromClerkSlug(rol),
  };
}

export async function requireScope(ctx: { auth: Auth }): Promise<Scope> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw unauthenticated();
  return scopeFromIdentity(identity);
}

export function hasCapability(scope: Scope, capability: Capability): boolean {
  return CAPABILITIES[scope.role].has(capability);
}

export function requireCapability(scope: Scope, capability: Capability): void {
  if (!hasCapability(scope, capability)) {
    throw new ConvexError({ code: "FORBIDDEN", capability });
  }
}
