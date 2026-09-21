/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { Webhook } from "svix";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TableNames } from "./_generated/dataModel";
import { DEFAULT_EXPENSE_CATEGORIES } from "./lib/scopeDefaults";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const SECRET = `whsec_${btoa("test-signing-secret-of-32-bytes!!")}`;
const ISSUER = "https://example.clerk.accounts.dev";

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {
    CLERK_WEBHOOK_SECRET: process.env.CLERK_WEBHOOK_SECRET,
    CLERK_FRONTEND_API_URL: process.env.CLERK_FRONTEND_API_URL,
  };
  process.env.CLERK_WEBHOOK_SECRET = SECRET;
  process.env.CLERK_FRONTEND_API_URL = ISSUER;
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type T = ReturnType<typeof convexTest>;
let seq = 0;

/** Sends a genuinely signed Clerk webhook through the real HTTP route. */
function deliver(
  t: T,
  type: string,
  data: unknown,
  opts: { secret?: string; tamper?: boolean } = {},
) {
  const body = JSON.stringify({ object: "event", type, data });
  const id = `msg_${++seq}`;
  const now = new Date();
  const signature = new Webhook(opts.secret ?? SECRET).sign(id, now, body);
  return t.fetch("/clerk-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(now.getTime() / 1000)),
      "svix-signature": signature,
    },
    body: opts.tamper ? body.replace("Acme", "Evil") : body,
  });
}

const all = (t: T, table: TableNames) =>
  t.run((ctx) => ctx.db.query(table).collect()) as Promise<Record<string, unknown>[]>;

const user = (over: Record<string, unknown> = {}) => ({
  id: "user_1",
  first_name: "Ada",
  last_name: "Lovelace",
  image_url: "https://img/1",
  email_addresses: [
    { id: "idn_1", email_address: "first@example.com" },
    { id: "idn_2", email_address: "ada@example.com" },
  ],
  primary_email_address_id: "idn_2",
  ...over,
});
const org = (over: Record<string, unknown> = {}) => ({
  id: "org_1",
  name: "Acme Inc.",
  slug: "acme",
  ...over,
});
const membership = (over: Record<string, unknown> = {}) => ({
  id: "orgmem_1",
  role: "org:owner",
  created_at: 1_700_000_000_000,
  organization: { id: "org_1" },
  public_user_data: { user_id: "user_1" },
  ...over,
});
const item = (over: Record<string, unknown> = {}) => ({
  id: "subi_1",
  status: "active",
  plan: { slug: "pro_org", features: [{ slug: "reports" }, { slug: "recurring_invoices" }] },
  period_start: 1000,
  period_end: 2000,
  ...over,
});
const subscription = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "active",
  payer: { organization_id: "org_1" },
  items: [item()],
  ...over,
});

describe("the webhook endpoint", () => {
  test("rejects a bad signature and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const res = await deliver(t, "user.created", user(), { secret: `whsec_${btoa("some-other-secret-32-bytes-long!!")}` });
    expect(res.status).toBe(400);
    expect(await all(t, "users")).toHaveLength(0);
  });

  test("rejects a body altered after signing", async () => {
    const t = convexTest(schema, modules);
    const res = await deliver(t, "organization.created", org(), { tamper: true });
    expect(res.status).toBe(400);
    expect(await all(t, "organizations")).toHaveLength(0);
  });

  test("rejects a request with no signature headers", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch("/clerk-webhook", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
  });

  test("reports a missing signing secret as a server error", async () => {
    delete process.env.CLERK_WEBHOOK_SECRET;
    const t = convexTest(schema, modules);
    const res = await deliver(t, "user.created", user());
    expect(res.status).toBe(500);
  });

  test("acknowledges events it does not act on, so they are not redelivered", async () => {
    const t = convexTest(schema, modules);
    const res = await deliver(t, "session.created", { id: "sess_1" });
    expect(res.status).toBe(200);
  });

  test("answers a verified but unusable payload with 400, not a retry-worthy 500", async () => {
    const t = convexTest(schema, modules);
    const res = await deliver(t, "organization.created", { id: "org_1" });
    expect(res.status).toBe(400);
  });
});

describe("users", () => {
  test("user.created stores the user and gives their personal scope defaults", async () => {
    const t = convexTest(schema, modules);
    expect((await deliver(t, "user.created", user())).status).toBe(200);

    expect(await all(t, "users")).toMatchObject([
      {
        clerkUserId: "user_1",
        tokenIdentifier: `${ISSUER}|user_1`,
        email: "ada@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
      },
    ]);
    expect(await all(t, "scopeSettings")).toMatchObject([
      {
        scopeId: "user_1",
        scopeKind: "user",
        businessName: "Ada Lovelace",
        currency: "USD",
        invoiceNumberPrefix: "INV-",
        nextInvoiceSeq: 1,
      },
    ]);
    const categories = (await all(t, "expenseCategories")) as { name: string; scopeId: string }[];
    expect(categories.map((c) => c.name).sort()).toEqual([...DEFAULT_EXPENSE_CATEGORIES].sort());
    expect(new Set(categories.map((c) => c.scopeId))).toEqual(new Set(["user_1"]));
  });

  test("replaying the same event changes nothing", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "user.created", user());
    const before = {
      users: await all(t, "users"),
      settings: await all(t, "scopeSettings"),
      categories: await all(t, "expenseCategories"),
    };
    await deliver(t, "user.created", user());
    await deliver(t, "user.created", user());
    expect({
      users: await all(t, "users"),
      settings: await all(t, "scopeSettings"),
      categories: await all(t, "expenseCategories"),
    }).toEqual(before);
  });

  test("user.updated changes the row in place and never duplicates defaults", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "user.created", user());
    await deliver(t, "user.updated", user({ first_name: "Augusta", image_url: null }));

    const [row] = (await all(t, "users")) as { firstName: string; imageUrl?: string }[];
    expect(row.firstName).toBe("Augusta");
    expect(row.imageUrl).toBeUndefined(); // removed upstream, removed here
    expect(await all(t, "users")).toHaveLength(1);
    expect(await all(t, "scopeSettings")).toHaveLength(1);
    expect(await all(t, "expenseCategories")).toHaveLength(DEFAULT_EXPENSE_CATEGORIES.length);
  });

  test("an update that arrives first still creates the user (out of order)", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "user.updated", user());
    expect(await all(t, "users")).toHaveLength(1);
    expect(await all(t, "scopeSettings")).toHaveLength(1);
  });

  test("user.deleted removes the user and is safe to replay; their books are kept", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "user.created", user());
    expect((await deliver(t, "user.deleted", { id: "user_1", deleted: true })).status).toBe(200);
    expect((await deliver(t, "user.deleted", { id: "user_1", deleted: true })).status).toBe(200);
    expect(await all(t, "users")).toHaveLength(0);
    expect(await all(t, "scopeSettings")).toHaveLength(1);
  });
});

describe("organizations and memberships", () => {
  test("creating an org produces organizations, memberships and scopeSettings", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "organization.created", org());
    await deliver(t, "organizationMembership.created", membership());

    expect(await all(t, "organizations")).toMatchObject([
      { clerkOrgId: "org_1", name: "Acme Inc.", slug: "acme" },
    ]);
    expect(await all(t, "memberships")).toMatchObject([
      { scopeId: "org_1", clerkUserId: "user_1", role: "org:owner", joinedAt: 1_700_000_000_000 },
    ]);
    expect(await all(t, "scopeSettings")).toMatchObject([
      { scopeId: "org_1", scopeKind: "org", businessName: "Acme Inc." },
    ]);
    expect(await all(t, "expenseCategories")).toHaveLength(DEFAULT_EXPENSE_CATEGORIES.length);
  });

  test("replaying org and membership events changes nothing", async () => {
    const t = convexTest(schema, modules);
    const play = async () => {
      await deliver(t, "organization.created", org());
      await deliver(t, "organizationMembership.created", membership());
    };
    await play();
    const before = [
      await all(t, "organizations"),
      await all(t, "memberships"),
      await all(t, "scopeSettings"),
      await all(t, "expenseCategories"),
    ];
    await play();
    await play();
    expect([
      await all(t, "organizations"),
      await all(t, "memberships"),
      await all(t, "scopeSettings"),
      await all(t, "expenseCategories"),
    ]).toEqual(before);
  });

  test("renaming an org updates the synced name but not the settings the user may have edited", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "organization.created", org());
    await t.run(async (ctx) => {
      const s = await ctx.db.query("scopeSettings").first();
      await ctx.db.patch("scopeSettings", s!._id, { businessName: "Custom Name" });
    });
    await deliver(t, "organization.updated", org({ name: "Acme Renamed" }));

    expect(await all(t, "organizations")).toMatchObject([{ name: "Acme Renamed" }]);
    expect(await all(t, "scopeSettings")).toMatchObject([{ businessName: "Custom Name" }]);
  });

  test("a slug or image removed upstream is cleared here too", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "organization.created", org({ image_url: "https://img/org" }));
    await deliver(t, "organization.updated", org({ slug: null, image_url: null }));
    const [row] = await all(t, "organizations");
    expect(row.slug).toBeUndefined();
    expect(row.imageUrl).toBeUndefined();
    expect(row.name).toBe("Acme Inc.");
  });

  test("a role change updates the role and keeps the original joinedAt", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "organizationMembership.created", membership());
    await deliver(
      t,
      "organizationMembership.updated",
      membership({ role: "org:accountant", created_at: 1_800_000_000_000 }),
    );
    expect(await all(t, "memberships")).toMatchObject([
      { role: "org:accountant", joinedAt: 1_700_000_000_000 },
    ]);
  });

  test("membership.deleted removes only that member, and is safe to replay", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "organizationMembership.created", membership());
    await deliver(
      t,
      "organizationMembership.created",
      membership({ public_user_data: { user_id: "user_2" } }),
    );
    const gone = membership();
    await deliver(t, "organizationMembership.deleted", gone);
    await deliver(t, "organizationMembership.deleted", gone);
    expect(await all(t, "memberships")).toMatchObject([{ clerkUserId: "user_2" }]);
  });

  test("organization.deleted removes synced rows but keeps the books", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "organization.created", org());
    await deliver(t, "organizationMembership.created", membership());
    await deliver(t, "subscription.created", subscription());
    // Another org's synced rows must be untouched.
    await deliver(t, "organization.created", org({ id: "org_2", name: "Other" }));
    await deliver(
      t,
      "organizationMembership.created",
      membership({ organization: { id: "org_2" } }),
    );
    await t.run((ctx) =>
      ctx.db.insert("clients", {
        scopeId: "org_1",
        scopeKind: "org",
        name: "Kept Client",
        currency: "USD",
        isArchived: false,
        outstandingCents: 0,
        totalBilledCents: 0,
        totalPaidCents: 0,
      }),
    );

    await deliver(t, "organization.deleted", { id: "org_1", deleted: true });
    await deliver(t, "organization.deleted", { id: "org_1", deleted: true });

    const orgs = (await all(t, "organizations")) as { clerkOrgId: string }[];
    expect(orgs.map((o) => o.clerkOrgId)).toEqual(["org_2"]);
    expect(await all(t, "memberships")).toMatchObject([{ scopeId: "org_2" }]);
    expect(await all(t, "subscriptions")).toHaveLength(0);
    expect(await all(t, "clients")).toHaveLength(1);
  });

  test("purging a large org continues in later batches", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      await t.run(async (ctx) => {
        for (let i = 0; i < 150; i++) {
          await ctx.db.insert("memberships", {
            scopeId: "org_big",
            clerkUserId: `user_${i}`,
            role: "org:viewer",
            joinedAt: 0,
          });
        }
      });
      await deliver(t, "organization.deleted", { id: "org_big", deleted: true });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await all(t, "memberships")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("subscriptions", () => {
  test("subscription.created records the plan from data.items[i].plan.slug for the payer's scope", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "subscription.created", subscription());
    expect(await all(t, "subscriptions")).toMatchObject([
      {
        scopeId: "org_1",
        scopeKind: "org",
        planKey: "pro",
        clerkPlanSlug: "pro_org",
        clerkSubscriptionId: "sub_1",
        clerkSubscriptionItemId: "subi_1",
        status: "active",
        features: ["reports", "recurring_invoices"],
        currentPeriodStart: 1000,
        currentPeriodEnd: 2000,
      },
    ]);
  });

  test("a personal payer becomes a user-scope subscription", async () => {
    const t = convexTest(schema, modules);
    await deliver(
      t,
      "subscription.created",
      subscription({
        payer: { user_id: "user_1" },
        items: [item({ id: "subi_9", plan: { slug: "business_user" } })],
      }),
    );
    expect(await all(t, "subscriptions")).toMatchObject([
      { scopeId: "user_1", scopeKind: "user", planKey: "business" },
    ]);
  });

  test("replaying subscription events never duplicates the row", async () => {
    const t = convexTest(schema, modules);
    for (const type of ["subscription.created", "subscription.active", "subscription.updated", "subscription.created"]) {
      await deliver(t, type, subscription());
    }
    expect(await all(t, "subscriptions")).toHaveLength(1);
  });

  test("past due updates the status in place", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "subscription.created", subscription());
    await deliver(
      t,
      "subscription.pastDue",
      subscription({ status: "past_due", items: [item({ status: "past_due" })] }),
    );
    expect(await all(t, "subscriptions")).toMatchObject([{ status: "past_due", planKey: "pro" }]);
  });

  test("an item event is matched by item id and updates the row, keeping its plan", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "subscription.created", subscription());
    await deliver(t, "subscriptionItem.canceled", {
      id: "subi_1",
      status: "canceled",
      payer: { organization_id: "org_1" },
      period_end: 3000,
    });
    expect(await all(t, "subscriptions")).toMatchObject([
      { status: "canceled", planKey: "pro", currentPeriodEnd: 3000 },
    ]);
  });

  test("a plan change adds a row for the new item and ends the old one", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "subscription.created", subscription());
    await deliver(
      t,
      "subscription.updated",
      subscription({
        items: [
          item({ id: "subi_1", status: "ended" }),
          item({ id: "subi_2", plan: { slug: "business_org" } }),
        ],
      }),
    );
    const rows = (await all(t, "subscriptions")) as {
      clerkSubscriptionItemId: string;
      planKey: string;
      status: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.clerkSubscriptionItemId === "subi_1")).toMatchObject({
      planKey: "pro",
      status: "ended",
    });
    expect(rows.find((r) => r.clerkSubscriptionItemId === "subi_2")).toMatchObject({
      planKey: "business",
      status: "active",
    });
  });

  test("an item event for an unseen item creates it when the plan is known", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "subscriptionItem.active", {
      id: "subi_7",
      status: "active",
      payer: { organization_id: "org_1" },
      plan: { slug: "business_org" },
    });
    expect(await all(t, "subscriptions")).toMatchObject([
      { clerkSubscriptionItemId: "subi_7", planKey: "business" },
    ]);
  });

  test("an item event with no payer is acknowledged and ignored", async () => {
    const t = convexTest(schema, modules);
    const res = await deliver(t, "subscriptionItem.ended", { id: "subi_1", status: "ended" });
    expect(res.status).toBe(200);
    expect(await all(t, "subscriptions")).toHaveLength(0);
  });

  test("an unrecognised plan slug is skipped, not guessed", async () => {
    const t = convexTest(schema, modules);
    const res = await deliver(
      t,
      "subscription.created",
      subscription({ items: [item({ plan: { slug: "enterprise_org" } })] }),
    );
    expect(res.status).toBe(200);
    expect(await all(t, "subscriptions")).toHaveLength(0);
  });

  test("an item id we had not recorded is adopted by (payer, plan)", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        scopeId: "org_1",
        scopeKind: "org",
        planKey: "pro",
        clerkPlanSlug: "pro_org",
        status: "active",
        features: [],
      }),
    );
    await deliver(t, "subscriptionItem.updated", {
      id: "subi_3",
      status: "active",
      payer: { organization_id: "org_1" },
      plan: { slug: "pro_org" },
      period_end: 5000,
    });
    expect(await all(t, "subscriptions")).toMatchObject([
      { clerkSubscriptionItemId: "subi_3", currentPeriodEnd: 5000 },
    ]);
  });

  test("subscriptions are scoped: another payer's row is untouched", async () => {
    const t = convexTest(schema, modules);
    await deliver(t, "subscription.created", subscription());
    await deliver(
      t,
      "subscription.created",
      subscription({
        id: "sub_2",
        payer: { organization_id: "org_2" },
        items: [item({ id: "subi_2", plan: { slug: "business_org" } })],
      }),
    );
    await deliver(t, "subscriptionItem.canceled", {
      id: "subi_1",
      status: "canceled",
      payer: { organization_id: "org_1" },
    });
    const rows = (await all(t, "subscriptions")) as { scopeId: string; status: string }[];
    expect(rows.find((r) => r.scopeId === "org_1")?.status).toBe("canceled");
    expect(rows.find((r) => r.scopeId === "org_2")?.status).toBe("active");
  });
});
