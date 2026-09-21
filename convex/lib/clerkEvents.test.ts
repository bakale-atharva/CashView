import { describe, expect, test } from "vitest";
import { MalformedEventError, parseClerkEvent } from "./clerkEvents";

describe("users", () => {
  test("uses the primary email, not the first one", () => {
    const op = parseClerkEvent({
      type: "user.created",
      data: {
        id: "user_1",
        first_name: "Ada",
        last_name: "Lovelace",
        image_url: "https://img/1",
        email_addresses: [
          { id: "idn_1", email_address: "first@example.com" },
          { id: "idn_2", email_address: "primary@example.com" },
        ],
        primary_email_address_id: "idn_2",
      },
    });
    expect(op).toEqual({
      kind: "user.upsert",
      clerkUserId: "user_1",
      email: "primary@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      imageUrl: "https://img/1",
    });
  });

  test("a user with no email (phone-only) is still valid", () => {
    const op = parseClerkEvent({
      type: "user.updated",
      data: { id: "user_1", email_addresses: [] },
    });
    expect(op).toMatchObject({ kind: "user.upsert", email: undefined });
  });

  test("user.deleted", () => {
    expect(
      parseClerkEvent({ type: "user.deleted", data: { id: "user_1", deleted: true } }),
    ).toEqual({ kind: "user.delete", clerkUserId: "user_1" });
  });
});

describe("organizations and memberships", () => {
  test("organization.created", () => {
    expect(
      parseClerkEvent({
        type: "organization.created",
        data: { id: "org_1", name: "Acme Inc.", slug: "acme", image_url: "https://i" },
      }),
    ).toEqual({
      kind: "org.upsert",
      clerkOrgId: "org_1",
      name: "Acme Inc.",
      slug: "acme",
      imageUrl: "https://i",
    });
  });

  test("a membership keeps Clerk's prefixed role and reads nested ids", () => {
    expect(
      parseClerkEvent({
        type: "organizationMembership.created",
        data: {
          id: "orgmem_1",
          role: "org:owner",
          created_at: 1_700_000_000_000,
          organization: { id: "org_1" },
          public_user_data: { user_id: "user_1" },
        },
      }),
    ).toEqual({
      kind: "membership.upsert",
      clerkOrgId: "org_1",
      clerkUserId: "user_1",
      role: "org:owner",
      joinedAt: 1_700_000_000_000,
    });
  });

  test("membership.deleted needs no role", () => {
    expect(
      parseClerkEvent({
        type: "organizationMembership.deleted",
        data: {
          organization: { id: "org_1" },
          public_user_data: { user_id: "user_1" },
        },
      }),
    ).toEqual({ kind: "membership.delete", clerkOrgId: "org_1", clerkUserId: "user_1" });
  });

  test.each([
    ["organization.created", { id: "org_1" }],
    ["organization.created", { name: "No id" }],
    ["organizationMembership.created", { role: "org:owner", organization: { id: "o" } }],
    ["organizationMembership.created", { organization: { id: "o" }, public_user_data: { user_id: "u" } }],
    ["user.created", {}],
  ])("%s with a missing field is malformed", (type, data) => {
    expect(() => parseClerkEvent({ type, data })).toThrow(MalformedEventError);
  });
});

describe("subscriptions", () => {
  const subscription = {
    id: "sub_1",
    status: "active",
    payer: { organization_id: "org_1", email: "x@example.com" },
    items: [
      {
        id: "subi_1",
        status: "active",
        plan: {
          slug: "pro_org",
          features: [{ slug: "reports" }, { slug: "recurring_invoices" }],
        },
        period_start: 1000,
        period_end: 2000,
      },
    ],
  };

  test("reads the payer from data.payer, the plan from items[i].plan.slug", () => {
    expect(parseClerkEvent({ type: "subscription.created", data: subscription })).toEqual({
      kind: "subscription.items",
      items: [
        {
          scopeId: "org_1",
          scopeKind: "org",
          clerkSubscriptionId: "sub_1",
          clerkSubscriptionItemId: "subi_1",
          planSlug: "pro_org",
          features: ["reports", "recurring_invoices"],
          status: "active",
          currentPeriodStart: 1000,
          currentPeriodEnd: 2000,
        },
      ],
    });
  });

  test("a top-level org_id is not the payer", () => {
    const data = { ...subscription, payer: undefined, org_id: "org_1" };
    expect(() => parseClerkEvent({ type: "subscription.created", data })).toThrow(
      MalformedEventError,
    );
  });

  test("a personal payer becomes user scope", () => {
    const data = { ...subscription, payer: { user_id: "user_1" } };
    const op = parseClerkEvent({ type: "subscription.updated", data });
    expect(op).toMatchObject({
      items: [{ scopeId: "user_1", scopeKind: "user" }],
    });
  });

  test("an item with no status inherits the subscription's", () => {
    const data = {
      ...subscription,
      status: "past_due",
      items: [{ id: "subi_1", plan: { slug: "pro_org" } }],
    };
    expect(parseClerkEvent({ type: "subscription.pastDue", data })).toMatchObject({
      items: [{ status: "past_due" }],
    });
  });

  test("an item event IS the item: no subscription id, payer at data.payer", () => {
    const op = parseClerkEvent({
      type: "subscriptionItem.canceled",
      data: {
        id: "subi_1",
        status: "canceled",
        payer: { organization_id: "org_1" },
        plan: { slug: "pro_org" },
        period_end: 2000,
      },
    });
    expect(op).toEqual({
      kind: "subscription.items",
      items: [
        {
          scopeId: "org_1",
          scopeKind: "org",
          clerkSubscriptionId: undefined,
          clerkSubscriptionItemId: "subi_1",
          planSlug: "pro_org",
          features: [],
          status: "canceled",
          currentPeriodStart: undefined,
          currentPeriodEnd: 2000,
        },
      ],
    });
  });

  test("an item event with no payer cannot be scoped, so it is skipped", () => {
    expect(
      parseClerkEvent({
        type: "subscriptionItem.ended",
        data: { id: "subi_1", status: "ended" },
      }),
    ).toBeNull();
  });

  test("a payer with neither id is malformed", () => {
    expect(() =>
      parseClerkEvent({
        type: "subscriptionItem.active",
        data: { id: "subi_1", payer: { email: "x@example.com" } },
      }),
    ).toThrow(MalformedEventError);
  });
});

describe("events we do not act on", () => {
  test.each(["session.created", "email.created", "paymentAttempt.created", "role.created"])(
    "%s is ignored",
    (type) => {
      expect(parseClerkEvent({ type, data: { id: "x" } })).toBeNull();
    },
  );
});
