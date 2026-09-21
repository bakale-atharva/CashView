// Shared helpers for tests. Not deployed: the Convex bundler skips any file
// whose name contains more than one dot.
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { PlanKey } from "./lib/validators";
import schema from "./schema";

export const modules = import.meta.glob("./**/*.ts");

const ISSUER = "https://example.clerk.accounts.dev";

export function identity(userId: string, org?: { id: string; rol: string }) {
  return {
    issuer: ISSUER,
    subject: userId,
    tokenIdentifier: `${ISSUER}|${userId}`,
    ...(org ? { o: { id: org.id, rol: org.rol, slg: "slug" } } : {}),
  };
}

export function setup() {
  const t = convexTest(schema, modules);
  return {
    t,
    owner: t.withIdentity(identity("user_alice", { id: "org_A", rol: "owner" })),
    accountant: t.withIdentity(identity("user_acc", { id: "org_A", rol: "accountant" })),
    viewer: t.withIdentity(identity("user_view", { id: "org_A", rol: "member" })),
    bob: t.withIdentity(identity("user_bob", { id: "org_B", rol: "owner" })),
    personal: t.withIdentity(identity("user_alice")),
  };
}
export type Ctx = ReturnType<typeof setup>;
export type Actor = Ctx["owner"];

export const page = (numItems: number, cursor: string | null = null) => ({
  numItems,
  cursor,
});

let itemSeq = 0;
/** Stands in for the webhook sync: writes a subscription row for a payer. */
export function subscribe(
  t: Ctx["t"],
  scopeId: string,
  planKey: PlanKey,
  status = "active",
  scopeKind: "org" | "user" = "org",
) {
  return t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      scopeId,
      scopeKind,
      planKey,
      clerkPlanSlug: `${planKey}_${scopeKind}`,
      clerkSubscriptionItemId: `subi_${++itemSeq}`,
      status,
      features: [],
    }),
  );
}

export const DAY = 86_400_000;
export const line = (over: Partial<{
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRatePct: number;
}> = {}) => ({
  description: "Consulting",
  quantity: 1,
  unitPriceCents: 10_000,
  taxRatePct: 0,
  ...over,
});

export const newClient = (actor: Actor, name = "Acme") =>
  actor.mutation(api.clients.create, { name });

/** Creates a draft for a fresh client. Returns both ids. */
export async function newDraft(
  actor: Actor,
  over: Record<string, unknown> = {},
): Promise<{ clientId: Id<"clients">; invoiceId: Id<"invoices"> }> {
  const clientId = (over.clientId as Id<"clients"> | undefined) ?? (await newClient(actor));
  const invoiceId = await actor.mutation(api.invoices.create, {
    clientId,
    lineItems: [line()],
    ...over,
  } as never);
  return { clientId, invoiceId };
}

/** Creates and sends an invoice. Returns its ids and public token. */
export async function newSent(actor: Actor, over: Record<string, unknown> = {}) {
  const { clientId, invoiceId } = await newDraft(actor, over);
  const { publicToken } = await actor.mutation(api.invoices.send, { id: invoiceId });
  return { clientId, invoiceId, publicToken };
}
