/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { DEFAULT_EXPENSE_CATEGORIES } from "./lib/scopeDefaults";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const ISSUER = "https://example.clerk.accounts.dev";

function identity(userId: string, org?: { id: string; rol: string }) {
  return {
    issuer: ISSUER,
    subject: userId,
    tokenIdentifier: `${ISSUER}|${userId}`,
    ...(org ? { o: { id: org.id, rol: org.rol, slg: "slug" } } : {}),
  };
}
function setup() {
  const t = convexTest(schema, modules);
  return {
    t,
    owner: t.withIdentity(identity("user_alice", { id: "org_A", rol: "owner" })),
    accountant: t.withIdentity(identity("user_acc", { id: "org_A", rol: "accountant" })),
    viewer: t.withIdentity(identity("user_view", { id: "org_A", rol: "member" })),
    bob: t.withIdentity(identity("user_bob", { id: "org_B", rol: "owner" })),
  };
}

const names = async (actor: ReturnType<typeof setup>["owner"]) =>
  (await actor.query(api.expenseCategories.list, {})).map((c) => c.name);

describe("defaults", () => {
  test("a scope that never got its starters has none, and ensureDefaults gives them", async () => {
    const { owner } = setup();
    expect(await names(owner)).toEqual([]);
    await owner.mutation(api.expenseCategories.ensureDefaults, {});
    expect(await names(owner)).toHaveLength(DEFAULT_EXPENSE_CATEGORIES.length);
  });

  test("ensureDefaults is safe to repeat and never duplicates", async () => {
    const { owner } = setup();
    await owner.mutation(api.expenseCategories.ensureDefaults, {});
    await owner.mutation(api.expenseCategories.ensureDefaults, {});
    expect(await names(owner)).toHaveLength(DEFAULT_EXPENSE_CATEGORIES.length);
  });

  test("the list is alphabetical regardless of case", async () => {
    const { owner } = setup();
    for (const name of ["banana", "Apple", "cherry", "Avocado"]) {
      await owner.mutation(api.expenseCategories.create, { name });
    }
    expect(await names(owner)).toEqual(["Apple", "Avocado", "banana", "cherry"]);
  });
});

describe("create and rename", () => {
  test("creates a custom category", async () => {
    const { t, owner } = setup();
    const id = await owner.mutation(api.expenseCategories.create, { name: "  Coffee  " });
    expect(await t.run((ctx) => ctx.db.get("expenseCategories", id))).toMatchObject({
      scopeId: "org_A",
      scopeKind: "org",
      name: "Coffee",
      isDefault: false,
    });
  });

  test("names are unique per scope, ignoring case, but free across scopes", async () => {
    const { owner, bob } = setup();
    await owner.mutation(api.expenseCategories.create, { name: "Coffee" });
    await expect(owner.mutation(api.expenseCategories.create, { name: "coffee" })).rejects.toMatchObject({
      data: { code: "CONFLICT", reason: "category_exists" },
    });
    await bob.mutation(api.expenseCategories.create, { name: "Coffee" });
  });

  test("a blank or over-long name is refused", async () => {
    const { owner } = setup();
    await expect(owner.mutation(api.expenseCategories.create, { name: "  " })).rejects.toMatchObject({
      data: { code: "INVALID_INPUT", field: "name" },
    });
    await expect(owner.mutation(api.expenseCategories.create, { name: "x".repeat(61) })).rejects.toMatchObject({
      data: { field: "name" },
    });
  });

  test("a scope holds at most 100 categories", async () => {
    const { t, owner } = setup();
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await ctx.db.insert("expenseCategories", {
          scopeId: "org_A",
          scopeKind: "org",
          name: `Cat ${i}`,
          isDefault: false,
        });
      }
    });
    await expect(owner.mutation(api.expenseCategories.create, { name: "One more" })).rejects.toMatchObject({
      data: { code: "CONFLICT", reason: "too_many_categories" },
    });
  });

  test("rename works, refuses a taken name, and allows changing only the case", async () => {
    const { owner } = setup();
    const a = await owner.mutation(api.expenseCategories.create, { name: "Travel" });
    await owner.mutation(api.expenseCategories.create, { name: "Meals" });

    await owner.mutation(api.expenseCategories.rename, { id: a, name: "Business travel" });
    expect(await names(owner)).toContain("Business travel");
    await expect(owner.mutation(api.expenseCategories.rename, { id: a, name: "meals" })).rejects.toMatchObject({
      data: { reason: "category_exists" },
    });
    await owner.mutation(api.expenseCategories.rename, { id: a, name: "BUSINESS TRAVEL" });
    expect(await names(owner)).toContain("BUSINESS TRAVEL");
  });
});

describe("remove", () => {
  test("deletes an unused category", async () => {
    const { owner } = setup();
    const id = await owner.mutation(api.expenseCategories.create, { name: "Temp" });
    await owner.mutation(api.expenseCategories.remove, { id });
    expect(await names(owner)).toEqual([]);
  });

  test("refuses while an expense uses it", async () => {
    const { t, owner } = setup();
    const id = await owner.mutation(api.expenseCategories.create, { name: "Used" });
    await t.run((ctx) =>
      ctx.db.insert("expenses", {
        scopeId: "org_A",
        scopeKind: "org",
        categoryId: id,
        vendor: "V",
        amountCents: 1,
        taxCents: 0,
        currency: "USD",
        spentAt: 0,
        paymentMethod: "card",
        ocrStatus: "none",
        isBillable: false,
      }),
    );
    await expect(owner.mutation(api.expenseCategories.remove, { id })).rejects.toMatchObject({
      data: { code: "CONFLICT", reason: "category_in_use" },
    });
    expect(await names(owner)).toEqual(["Used"]);
  });
});

describe("roles and isolation", () => {
  test("a viewer can list but not change anything", async () => {
    const { owner, viewer } = setup();
    const id = await owner.mutation(api.expenseCategories.create, { name: "Coffee" });
    expect(await names(viewer)).toEqual(["Coffee"]);

    const forbidden = { data: { code: "FORBIDDEN", capability: "expenses.write" } };
    await expect(viewer.mutation(api.expenseCategories.create, { name: "X" })).rejects.toMatchObject(forbidden);
    await expect(viewer.mutation(api.expenseCategories.rename, { id, name: "X" })).rejects.toMatchObject(forbidden);
    await expect(viewer.mutation(api.expenseCategories.remove, { id })).rejects.toMatchObject(forbidden);
    await expect(viewer.mutation(api.expenseCategories.ensureDefaults, {})).rejects.toMatchObject(forbidden);
  });

  test("an accountant can manage categories", async () => {
    const { accountant } = setup();
    const id = await accountant.mutation(api.expenseCategories.create, { name: "Tools" });
    await accountant.mutation(api.expenseCategories.rename, { id, name: "Software tools" });
    await accountant.mutation(api.expenseCategories.remove, { id });
  });

  test("each scope sees and edits only its own", async () => {
    const { owner, bob } = setup();
    const mine = await owner.mutation(api.expenseCategories.create, { name: "Mine" });
    await bob.mutation(api.expenseCategories.create, { name: "Theirs" });
    expect(await names(owner)).toEqual(["Mine"]);
    expect(await names(bob)).toEqual(["Theirs"]);
    await expect(bob.mutation(api.expenseCategories.rename, { id: mine, name: "Pwned" })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
    await expect(bob.mutation(api.expenseCategories.remove, { id: mine })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
  });
});
