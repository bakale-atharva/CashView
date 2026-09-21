/**
 * Turns a verified Clerk webhook into a typed sync operation, or null when the
 * event is one we don't act on. Pure: no I/O, so the payload-shape traps live
 * in one testable place.
 *
 * Payload facts this encodes (Clerk sends snake_case; event names camelCase):
 * - The payer is nested at `data.payer.{user_id, organization_id}`, never a
 *   top-level org id.
 * - Subscription events carry `items[]`, each with `plan.slug`. Item events
 *   ARE the item, with no reference back to their subscription.
 * - Membership roles arrive prefixed ("org:owner"); the JWT's are not.
 */

export type ItemOp = {
  scopeId: string;
  scopeKind: "org" | "user";
  clerkSubscriptionId?: string;
  clerkSubscriptionItemId: string;
  /** Absent on item events that don't repeat the plan. */
  planSlug?: string;
  features: string[];
  status: string;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
};

export type SyncOp =
  | {
      kind: "user.upsert";
      clerkUserId: string;
      email?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  | { kind: "user.delete"; clerkUserId: string }
  | {
      kind: "org.upsert";
      clerkOrgId: string;
      name: string;
      slug?: string;
      imageUrl?: string;
    }
  | { kind: "org.delete"; clerkOrgId: string }
  | {
      kind: "membership.upsert";
      clerkOrgId: string;
      clerkUserId: string;
      role: string;
      joinedAt: number;
    }
  | { kind: "membership.delete"; clerkOrgId: string; clerkUserId: string }
  | { kind: "subscription.items"; items: ItemOp[] };

/** A verified event whose payload doesn't have the shape we expect. */
export class MalformedEventError extends Error {}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;
const optNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function need<T>(value: T | undefined, what: string, type: string): T {
  if (value === undefined) {
    throw new MalformedEventError(`${type}: missing ${what}`);
  }
  return value;
}

function payer(
  data: Rec,
  type: string,
): { scopeId: string; scopeKind: "org" | "user" } | null {
  const p = data.payer;
  if (!isRec(p)) return null;
  const orgId = optStr(p.organization_id);
  if (orgId) return { scopeId: orgId, scopeKind: "org" };
  const userId = optStr(p.user_id);
  if (userId) return { scopeId: userId, scopeKind: "user" };
  throw new MalformedEventError(`${type}: payer has no user or organization`);
}

function featureSlugs(plan: unknown): string[] {
  if (!isRec(plan) || !Array.isArray(plan.features)) return [];
  return plan.features.flatMap((f) => {
    const slug = isRec(f) ? optStr(f.slug) : undefined;
    return slug ? [slug] : [];
  });
}

function itemOp(
  item: unknown,
  scope: { scopeId: string; scopeKind: "org" | "user" },
  subscription: { id?: string; status?: string },
  type: string,
): ItemOp {
  if (!isRec(item)) throw new MalformedEventError(`${type}: item is not an object`);
  const plan = isRec(item.plan) ? item.plan : undefined;
  return {
    ...scope,
    clerkSubscriptionId: subscription.id,
    clerkSubscriptionItemId: need(optStr(item.id), "item id", type),
    planSlug: plan ? optStr(plan.slug) : undefined,
    features: featureSlugs(plan),
    status: optStr(item.status) ?? subscription.status ?? "active",
    currentPeriodStart: optNum(item.period_start),
    currentPeriodEnd: optNum(item.period_end),
  };
}

function primaryEmail(data: Rec): string | undefined {
  if (!Array.isArray(data.email_addresses)) return undefined;
  const emails = data.email_addresses.filter(isRec);
  const primary = emails.find((e) => e.id === data.primary_email_address_id);
  return optStr((primary ?? emails[0])?.email_address);
}

export function parseClerkEvent(event: {
  type: string;
  data: unknown;
}): SyncOp | null {
  const { type } = event;
  if (!isRec(event.data)) {
    // Every event we handle has an object payload.
    if (HANDLED.has(type)) throw new MalformedEventError(`${type}: no data`);
    return null;
  }
  const data = event.data;

  switch (type) {
    case "user.created":
    case "user.updated":
      return {
        kind: "user.upsert",
        clerkUserId: need(optStr(data.id), "id", type),
        email: primaryEmail(data),
        firstName: optStr(data.first_name),
        lastName: optStr(data.last_name),
        imageUrl: optStr(data.image_url),
      };
    case "user.deleted":
      return { kind: "user.delete", clerkUserId: need(optStr(data.id), "id", type) };

    case "organization.created":
    case "organization.updated":
      return {
        kind: "org.upsert",
        clerkOrgId: need(optStr(data.id), "id", type),
        name: need(optStr(data.name), "name", type),
        slug: optStr(data.slug),
        imageUrl: optStr(data.image_url),
      };
    case "organization.deleted":
      return { kind: "org.delete", clerkOrgId: need(optStr(data.id), "id", type) };

    case "organizationMembership.created":
    case "organizationMembership.updated":
    case "organizationMembership.deleted": {
      const org = isRec(data.organization) ? data.organization : undefined;
      const user = isRec(data.public_user_data) ? data.public_user_data : undefined;
      const clerkOrgId = need(optStr(org?.id), "organization.id", type);
      const clerkUserId = need(optStr(user?.user_id), "public_user_data.user_id", type);
      if (type === "organizationMembership.deleted") {
        return { kind: "membership.delete", clerkOrgId, clerkUserId };
      }
      return {
        kind: "membership.upsert",
        clerkOrgId,
        clerkUserId,
        role: need(optStr(data.role), "role", type),
        joinedAt: optNum(data.created_at) ?? 0,
      };
    }

    case "subscription.created":
    case "subscription.updated":
    case "subscription.active":
    case "subscription.pastDue": {
      const scope = payer(data, type);
      if (scope === null) throw new MalformedEventError(`${type}: no payer`);
      const subscription = {
        id: optStr(data.id),
        status: optStr(data.status),
      };
      const items = Array.isArray(data.items) ? data.items : [];
      return {
        kind: "subscription.items",
        items: items.map((item) => itemOp(item, scope, subscription, type)),
      };
    }

    case "subscriptionItem.created":
    case "subscriptionItem.updated":
    case "subscriptionItem.active":
    case "subscriptionItem.canceled":
    case "subscriptionItem.upcoming":
    case "subscriptionItem.ended":
    case "subscriptionItem.expired":
    case "subscriptionItem.abandoned":
    case "subscriptionItem.incomplete":
    case "subscriptionItem.pastDue": {
      // The payload is the item itself. Without a payer there is no scope to
      // look it up in, so it cannot be applied; that is not malformed.
      const scope = payer(data, type);
      if (scope === null) return null;
      return { kind: "subscription.items", items: [itemOp(data, scope, {}, type)] };
    }

    default:
      return null;
  }
}

const HANDLED = new Set([
  "user.created",
  "user.updated",
  "user.deleted",
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organizationMembership.created",
  "organizationMembership.updated",
  "organizationMembership.deleted",
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.pastDue",
]);
