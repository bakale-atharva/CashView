import type { UserIdentity } from "convex/server";
import { describe, expect, test } from "vitest";
import {
  hasCapability,
  requireCapability,
  roleFromClerkSlug,
  scopeFromIdentity,
} from "./scope";
import type { Scope } from "./validators";

const ISSUER = "https://example.clerk.accounts.dev";

// Shapes copied from the B1.0 probe of the real dev Clerk instance.
const personal = {
  tokenIdentifier: `${ISSUER}|user_1`,
  issuer: ISSUER,
  subject: "user_1",
  sid: "sess_1",
  sts: "active",
  v: 2,
} as UserIdentity;

const inOrg = (rol: string) =>
  ({
    ...personal,
    o: { id: "org_1", rol, slg: "acme-inc" },
  }) as UserIdentity;

describe("scopeFromIdentity", () => {
  test("no org claim means personal scope keyed by the user id", () => {
    expect(scopeFromIdentity(personal)).toEqual({
      scopeId: "user_1",
      scopeKind: "user",
      userId: "user_1",
      role: "admin",
    });
  });

  test("the nested o claim means org scope keyed by the org id", () => {
    expect(scopeFromIdentity(inOrg("accountant"))).toEqual({
      scopeId: "org_1",
      scopeKind: "org",
      userId: "user_1",
      role: "accountant",
    });
  });

  test("a flattened o.id key is not read", () => {
    const flattened = { ...personal, "o.id": "org_1", "o.rol": "admin" };
    expect(scopeFromIdentity(flattened as UserIdentity).scopeKind).toBe("user");
  });

  test.each([
    ["a string", "org_1"],
    ["an array", ["org_1"]],
    ["missing an id", { rol: "admin" }],
    ["an empty id", { id: "", rol: "admin" }],
    ["a numeric id", { id: 7, rol: "admin" }],
  ])("a malformed org claim (%s) fails closed, not to personal scope", (_, o) => {
    const identity = { ...personal, o } as UserIdentity;
    expect(() => scopeFromIdentity(identity)).toThrow();
  });

  test("a missing subject is refused", () => {
    const identity = { ...personal, subject: "" } as UserIdentity;
    expect(() => scopeFromIdentity(identity)).toThrow();
  });
});

describe("roleFromClerkSlug", () => {
  test.each([
    ["admin", "admin"],
    ["accountant", "accountant"],
    ["viewer", "viewer"],
    ["org:admin", "admin"],
    ["org:accountant", "accountant"],
    ["org:viewer", "viewer"],
  ])("%s -> %s", (slug, role) => {
    expect(roleFromClerkSlug(slug)).toBe(role);
  });

  test.each(["member", "org:member", "billing_manager", "", "ADMIN", undefined, null, 5])(
    "unmapped role %j falls back to viewer",
    (slug) => {
      expect(roleFromClerkSlug(slug)).toBe("viewer");
    },
  );
});

describe("capability matrix", () => {
  const as = (role: Scope["role"]): Scope => ({
    scopeId: "org_1",
    scopeKind: "org",
    userId: "user_1",
    role,
  });

  test("viewer can read but not write or manage", () => {
    expect(hasCapability(as("viewer"), "invoices.read")).toBe(true);
    expect(hasCapability(as("viewer"), "invoices.write")).toBe(false);
    expect(hasCapability(as("viewer"), "audit.read")).toBe(false);
  });

  test("accountant can write but not manage", () => {
    expect(hasCapability(as("accountant"), "payments.record")).toBe(true);
    expect(hasCapability(as("accountant"), "settings.manage")).toBe(false);
    expect(hasCapability(as("accountant"), "billing.manage")).toBe(false);
  });

  test("admin can do everything", () => {
    for (const capability of [
      "clients.write",
      "settings.manage",
      "members.manage",
      "billing.manage",
      "audit.read",
    ] as const) {
      expect(hasCapability(as("admin"), capability)).toBe(true);
    }
  });

  test("requireCapability throws a typed FORBIDDEN", () => {
    expect(() => requireCapability(as("viewer"), "clients.write")).toThrowError(
      expect.objectContaining({
        data: { code: "FORBIDDEN", capability: "clients.write" },
      }),
    );
  });

  test("personal scope grants everything", () => {
    const scope = scopeFromIdentity(personal);
    expect(hasCapability(scope, "billing.manage")).toBe(true);
    expect(hasCapability(scope, "audit.read")).toBe(true);
  });
});
