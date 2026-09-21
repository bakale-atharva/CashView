import { httpRouter } from "convex/server";
import { Webhook } from "svix";
import { internal } from "./_generated/api";
import { env, httpAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { MalformedEventError, parseClerkEvent } from "./lib/clerkEvents";
import type { SyncOp } from "./lib/clerkEvents";

const http = httpRouter();

async function apply(ctx: ActionCtx, op: SyncOp): Promise<void> {
  switch (op.kind) {
    case "user.upsert":
      return void (await ctx.runMutation(internal.sync.upsertUser, {
        clerkUserId: op.clerkUserId,
        email: op.email,
        firstName: op.firstName,
        lastName: op.lastName,
        imageUrl: op.imageUrl,
      }));
    case "user.delete":
      return void (await ctx.runMutation(internal.sync.deleteUser, {
        clerkUserId: op.clerkUserId,
      }));
    case "org.upsert":
      return void (await ctx.runMutation(internal.sync.upsertOrganization, {
        clerkOrgId: op.clerkOrgId,
        name: op.name,
        slug: op.slug,
        imageUrl: op.imageUrl,
      }));
    case "org.delete":
      return void (await ctx.runMutation(internal.sync.deleteOrganization, {
        clerkOrgId: op.clerkOrgId,
      }));
    case "membership.upsert":
      return void (await ctx.runMutation(internal.sync.upsertMembership, {
        clerkOrgId: op.clerkOrgId,
        clerkUserId: op.clerkUserId,
        role: op.role,
        joinedAt: op.joinedAt,
      }));
    case "membership.delete":
      return void (await ctx.runMutation(internal.sync.deleteMembership, {
        clerkOrgId: op.clerkOrgId,
        clerkUserId: op.clerkUserId,
      }));
    case "subscription.items":
      return void (await ctx.runMutation(internal.sync.upsertSubscriptionItems, {
        items: op.items,
      }));
  }
}

const text = (body: string, status: number) => new Response(body, { status });

/**
 * Clerk webhook endpoint. Register the deployment's `.site` URL (not `.cloud`)
 * with a path of /clerk-webhook, and put the endpoint's signing secret in the
 * Convex environment as CLERK_WEBHOOK_SECRET.
 *
 * Status codes drive Clerk's retries: a bad signature or an unusable payload
 * is 400 (retrying cannot help), a failed write is 500 (retrying should), and
 * an event we don't act on is 200 so it is not redelivered.
 */
http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = env.CLERK_WEBHOOK_SECRET;
    if (!secret) {
      console.error("CLERK_WEBHOOK_SECRET is not set in the Convex environment.");
      return text("Webhook is not configured", 500);
    }

    // Verification needs the exact bytes that were signed.
    const payload = await request.text();
    try {
      // svix 2.x returns nothing on success; it only throws on failure.
      new Webhook(secret).verify(payload, {
        "svix-id": request.headers.get("svix-id") ?? "",
        "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
        "svix-signature": request.headers.get("svix-signature") ?? "",
      });
    } catch {
      return text("Invalid signature", 400);
    }

    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return text("Unrecognised payload", 400);
    }

    if (
      typeof event !== "object" ||
      event === null ||
      !("type" in event) ||
      typeof event.type !== "string"
    ) {
      return text("Unrecognised payload", 400);
    }

    let op: SyncOp | null;
    try {
      op = parseClerkEvent({
        type: event.type,
        data: "data" in event ? event.data : undefined,
      });
    } catch (error) {
      if (error instanceof MalformedEventError) {
        console.error(error.message);
        return text("Malformed event", 400);
      }
      throw error;
    }

    if (op === null) return text("Ignored", 200);

    await apply(ctx, op);
    return text("OK", 200);
  }),
});

export default http;
