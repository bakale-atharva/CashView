/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { DAY_MS, startOfUtcDay } from "./lib/dates";
import { MAX_RECEIPT_BYTES } from "./lib/receipts";
import type { PlanKey } from "./lib/validators";
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
    personal: t.withIdentity(identity("user_alice")),
  };
}
type Ctx = ReturnType<typeof setup>;
type Actor = Ctx["owner"];

const page = (numItems: number, cursor: string | null = null) => ({ numItems, cursor });

let itemSeq = 0;
const subscribe = (t: Ctx["t"], scopeId: string, planKey: PlanKey) =>
  t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      scopeId,
      scopeKind: "org",
      planKey,
      clerkPlanSlug: `${planKey}_org`,
      clerkSubscriptionItemId: `subi_${++itemSeq}`,
      status: "active",
      features: [],
    }),
  );

const newCategory = (actor: Actor, name = "Software") => actor.mutation(api.expenseCategories.create, { name });
const newClient = (actor: Actor, name = "Acme") => actor.mutation(api.clients.create, { name });

const expenseArgs = (categoryId: Id<"expenseCategories">, over: Record<string, unknown> = {}) =>
  ({
    categoryId,
    vendor: "Acme Supplies",
    amountCents: 5_000,
    spentAt: Date.now() - DAY_MS,
    paymentMethod: "card",
    ...over,
  }) as never;

async function newExpense(actor: Actor, over: Record<string, unknown> = {}) {
  const categoryId = (over.categoryId as Id<"expenseCategories"> | undefined) ?? (await newCategory(actor));
  const id = await actor.mutation(api.expenses.create, expenseArgs(categoryId, over));
  return { categoryId, id };
}

/**
 * Stores a file the way an upload would, returning its storage id. Real Convex
 * records the upload's Content-Type on the `_storage` document; convex-test
 * records only size and hash, so the type is stamped on here.
 */
const store = (t: Ctx["t"], body: BlobPart = "receipt-bytes", type = "image/png") =>
  t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([body], { type }));
    await ctx.db.patch(id as never, { contentType: type } as never);
    return id;
  });
const exists = (t: Ctx["t"], id: Id<"_storage">) => t.run(async (ctx) => (await ctx.storage.getUrl(id)) !== null);
const row = (t: Ctx["t"], id: Id<"expenses">) => t.run((ctx) => ctx.db.get("expenses", id));

describe("create", () => {
  test("stores the expense in the caller's scope with sensible defaults", async () => {
    const { t, owner } = setup();
    const { id, categoryId } = await newExpense(owner, {
      vendor: "  Staples  ",
      description: " Paper ",
      taxCents: 800,
      spentAt: Date.UTC(2026, 0, 5, 14),
    });
    expect(await row(t, id)).toMatchObject({
      scopeId: "org_A",
      scopeKind: "org",
      categoryId,
      vendor: "Staples",
      description: "Paper",
      amountCents: 5_000,
      taxCents: 800,
      currency: "USD",
      spentAt: Date.UTC(2026, 0, 5),
      paymentMethod: "card",
      isBillable: false,
      ocrStatus: "none",
    });
  });

  test("accepts no receipt, scan status or scope from the request", async () => {
    const { owner } = setup();
    const categoryId = await newCategory(owner);
    for (const extra of [{ ocrStatus: "done" }, { receiptStorageId: "x" }, { scopeId: "org_B" }, { ocrRaw: "{}" }]) {
      await expect(owner.mutation(api.expenses.create, expenseArgs(categoryId, extra))).rejects.toThrow();
    }
  });

  test("rejects bad input with a typed error naming the field", async () => {
    const { owner } = setup();
    const categoryId = await newCategory(owner);
    const bad = async (over: Record<string, unknown>) =>
      owner.mutation(api.expenses.create, expenseArgs(categoryId, over)).catch((e) => e.data);
    expect(await bad({ amountCents: 0 })).toMatchObject({ code: "INVALID_INPUT", field: "amountCents" });
    expect(await bad({ taxCents: 6_000 })).toMatchObject({ field: "taxCents" });
    expect(await bad({ spentAt: Date.now() + 10 * DAY_MS })).toMatchObject({ field: "spentAt" });
    expect(await bad({ vendor: "  " })).toMatchObject({ field: "vendor" });
    expect(await bad({ isBillable: true })).toMatchObject({ field: "clientId" });
    expect(await bad({ currency: "dollars" })).toMatchObject({ field: "currency" });
  });

  test("the category and client must belong to the caller's scope", async () => {
    const { owner, bob } = setup();
    const mine = await newCategory(owner);
    const bobsCategory = await newCategory(bob, "Theirs");
    const bobsClient = await newClient(bob, "Bob Co");

    await expect(
      owner.mutation(api.expenses.create, expenseArgs(bobsCategory)),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    await expect(
      owner.mutation(api.expenses.create, expenseArgs(mine, { clientId: bobsClient })),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  test("a billable expense is tied to a client", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    const { id } = await newExpense(owner, { isBillable: true, clientId });
    expect(await row(t, id)).toMatchObject({ isBillable: true, clientId });
  });

  test("a non-base currency needs the multi-currency feature", async () => {
    const { t, owner } = setup();
    const categoryId = await newCategory(owner);
    await expect(
      owner.mutation(api.expenses.create, expenseArgs(categoryId, { currency: "eur" })),
    ).rejects.toMatchObject({ data: { code: "UPGRADE_REQUIRED", feature: "multi_currency" } });
    await owner.mutation(api.expenses.create, expenseArgs(categoryId, { currency: "USD" }));

    await subscribe(t, "org_A", "business");
    const id = await owner.mutation(api.expenses.create, expenseArgs(categoryId, { currency: "eur" }));
    expect((await row(t, id))?.currency).toBe("EUR");
  });

  test("expenses have no quota", async () => {
    const { owner } = setup();
    const categoryId = await newCategory(owner);
    for (let i = 0; i < 25; i++) await owner.mutation(api.expenses.create, expenseArgs(categoryId));
  });

  test("a viewer is refused; an accountant may record expenses; personal scope too", async () => {
    const { owner, viewer, accountant, personal } = setup();
    const categoryId = await newCategory(owner);
    await expect(viewer.mutation(api.expenses.create, expenseArgs(categoryId))).rejects.toMatchObject({
      data: { code: "FORBIDDEN", capability: "expenses.write" },
    });
    await accountant.mutation(api.expenses.create, expenseArgs(categoryId));
    await personal.mutation(api.expenses.create, expenseArgs(await newCategory(personal)));
  });

  test("is audited without create calling anything", async () => {
    const { owner } = setup();
    const { id } = await newExpense(owner, { vendor: "Staples" });
    const log = await owner.query(api.audit.listAuditLog, {
      paginationOpts: page(10),
      entity: { table: "expenses", id },
    });
    expect(log.page).toMatchObject([{ action: "create", entityLabel: "Staples" }]);
  });
});

describe("update", () => {
  test("replaces the editable fields; omitted optional ones are cleared", async () => {
    const { t, owner } = setup();
    const clientId = await newClient(owner);
    const { id, categoryId } = await newExpense(owner, {
      description: "old",
      taxCents: 100,
      clientId,
      isBillable: true,
    });
    await owner.mutation(api.expenses.update, {
      id,
      ...(expenseArgs(categoryId, { vendor: "New Vendor", amountCents: 9_000 }) as object),
    } as never);

    const after = await row(t, id);
    expect(after).toMatchObject({ vendor: "New Vendor", amountCents: 9_000, taxCents: 0, isBillable: false });
    expect(after?.description).toBeUndefined();
    expect(after?.clientId).toBeUndefined();
  });

  test("never touches the receipt", async () => {
    const { t, owner } = setup();
    const { id, categoryId } = await newExpense(owner);
    const file = await store(t);
    await owner.mutation(api.expenses.attachReceipt, { id, storageId: file });
    await owner.mutation(api.expenses.update, {
      id,
      ...(expenseArgs(categoryId, { vendor: "Renamed" }) as object),
    } as never);
    expect((await row(t, id))?.receiptStorageId).toBe(file);
  });

  test("another org's expense cannot be edited", async () => {
    const { t, owner, bob } = setup();
    const { id } = await newExpense(bob);
    const mineCategory = await newCategory(owner);
    await expect(
      owner.mutation(api.expenses.update, { id, ...(expenseArgs(mineCategory) as object) } as never),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
    expect((await row(t, id))?.vendor).toBe("Acme Supplies");
  });

  test("can be moved to another of the scope's categories, but not another org's", async () => {
    const { t, owner, bob } = setup();
    const { id } = await newExpense(owner);
    const other = await newCategory(owner, "Travel");
    await owner.mutation(api.expenses.update, { id, ...(expenseArgs(other) as object) } as never);
    expect((await row(t, id))?.categoryId).toBe(other);

    const bobsCategory = await newCategory(bob);
    await expect(
      owner.mutation(api.expenses.update, { id, ...(expenseArgs(bobsCategory) as object) } as never),
    ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  test("records a field diff in the audit trail", async () => {
    const { owner } = setup();
    const { id, categoryId } = await newExpense(owner);
    await owner.mutation(api.expenses.update, {
      id,
      ...(expenseArgs(categoryId, { amountCents: 7_000 }) as object),
    } as never);
    const log = await owner.query(api.audit.listAuditLog, {
      paginationOpts: page(10),
      entity: { table: "expenses", id },
    });
    expect(log.page[0].changes).toContainEqual({ field: "amountCents", from: 5_000, to: 7_000 });
  });
});

describe("get and list", () => {
  test("get returns the expense with its category and client", async () => {
    const { owner } = setup();
    const clientId = await newClient(owner, "Acme");
    const { id } = await newExpense(owner, { clientId, isBillable: true });
    const got = await owner.query(api.expenses.get, { id });
    expect(got.expense.vendor).toBe("Acme Supplies");
    expect(got.category).toMatchObject({ name: "Software" });
    expect(got.client).toMatchObject({ name: "Acme" });
    expect(got.receiptUrl).toBeNull();
  });

  test("get: another org's expense is NOT_FOUND; a viewer can read", async () => {
    const { owner, viewer, bob } = setup();
    const { id } = await newExpense(owner);
    expect((await viewer.query(api.expenses.get, { id })).expense._id).toBe(id);
    await expect(bob.query(api.expenses.get, { id })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  });

  test("list is newest first, resolves names, and hides the storage id", async () => {
    const { owner } = setup();
    const categoryId = await newCategory(owner, "Travel");
    const clientId = await newClient(owner, "Acme");
    for (const [i, day] of [1, 3, 2].entries()) {
      await owner.mutation(
        api.expenses.create,
        expenseArgs(categoryId, { spentAt: Date.UTC(2026, 0, day), vendor: `V${i}`, clientId }),
      );
    }
    const result = await owner.query(api.expenses.list, { paginationOpts: page(10) });
    expect(result.page.map((e) => e.spentAt)).toEqual([
      Date.UTC(2026, 0, 3),
      Date.UTC(2026, 0, 2),
      Date.UTC(2026, 0, 1),
    ]);
    expect(result.page[0]).toMatchObject({ categoryName: "Travel", clientName: "Acme", hasReceipt: false });
    expect(result.page[0]).not.toHaveProperty("receiptStorageId");
  });

  test("list paginates", async () => {
    const { owner } = setup();
    const categoryId = await newCategory(owner);
    for (let i = 0; i < 3; i++) await owner.mutation(api.expenses.create, expenseArgs(categoryId));
    const first = await owner.query(api.expenses.list, { paginationOpts: page(2) });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const second = await owner.query(api.expenses.list, { paginationOpts: page(2, first.continueCursor) });
    expect(second.page).toHaveLength(1);
  });

  test("list filters by category, client and an inclusive date range, alone and combined", async () => {
    const { owner } = setup();
    const travel = await newCategory(owner, "Travel");
    const meals = await newCategory(owner, "Meals");
    const acme = await newClient(owner, "Acme");
    const add = (categoryId: Id<"expenseCategories">, day: number, clientId?: Id<"clients">) =>
      owner.mutation(
        api.expenses.create,
        expenseArgs(categoryId, { spentAt: Date.UTC(2026, 0, day), ...(clientId ? { clientId } : {}) }),
      );
    await add(travel, 1, acme);
    await add(travel, 10);
    await add(meals, 5, acme);
    await add(meals, 20);

    const count = async (args: object) =>
      (await owner.query(api.expenses.list, { paginationOpts: page(50), ...args })).page.length;
    const d = (day: number) => Date.UTC(2026, 0, day);

    expect(await count({})).toBe(4);
    expect(await count({ categoryId: travel })).toBe(2);
    expect(await count({ clientId: acme })).toBe(2);
    expect(await count({ from: d(5), to: d(10) })).toBe(2); // inclusive both ends
    expect(await count({ from: d(6) })).toBe(2);
    expect(await count({ to: d(4) })).toBe(1);
    expect(await count({ categoryId: travel, from: d(2) })).toBe(1);
    expect(await count({ categoryId: meals, clientId: acme })).toBe(1);
    expect(await count({ clientId: acme, from: d(2), to: d(30) })).toBe(1);
    expect(await count({ categoryId: travel, from: d(2), to: d(4) })).toBe(0);
  });

  test("list never shows another scope's expenses", async () => {
    const { owner, bob, personal } = setup();
    await newExpense(owner);
    await newExpense(bob);
    await newExpense(personal);
    for (const actor of [owner, bob, personal]) {
      expect((await actor.query(api.expenses.list, { paginationOpts: page(10) })).page).toHaveLength(1);
    }
  });

  test("every function needs a signed-in caller", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const no = { data: { code: "UNAUTHENTICATED" } };
    await expect(t.query(api.expenses.list, { paginationOpts: page(10) })).rejects.toMatchObject(no);
    await expect(t.query(api.expenses.get, { id })).rejects.toMatchObject(no);
    await expect(t.mutation(api.expenses.remove, { id })).rejects.toMatchObject(no);
    await expect(t.mutation(api.expenses.generateReceiptUploadUrl, {})).rejects.toMatchObject(no);
  });
});

describe("remove", () => {
  test("deletes the expense and its receipt file", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const file = await store(t);
    await owner.mutation(api.expenses.attachReceipt, { id, storageId: file });

    await owner.mutation(api.expenses.remove, { id });
    expect(await row(t, id)).toBeNull();
    expect(await exists(t, file)).toBe(false);
  });

  test("a viewer cannot delete; another org's expense is NOT_FOUND", async () => {
    const { t, owner, viewer, bob } = setup();
    const { id } = await newExpense(owner);
    await expect(viewer.mutation(api.expenses.remove, { id })).rejects.toMatchObject({
      data: { code: "FORBIDDEN" },
    });
    await expect(bob.mutation(api.expenses.remove, { id })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
    expect(await row(t, id)).not.toBeNull();
  });
});

describe("receipts", () => {
  test("hands out an upload URL to writers only", async () => {
    const { owner, viewer } = setup();
    expect(typeof (await owner.mutation(api.expenses.generateReceiptUploadUrl, {}))).toBe("string");
    await expect(viewer.mutation(api.expenses.generateReceiptUploadUrl, {})).rejects.toMatchObject({
      data: { code: "FORBIDDEN", capability: "expenses.write" },
    });
  });

  test("attaching stores it and get mints a URL", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const file = await store(t);
    expect(await owner.mutation(api.expenses.attachReceipt, { id, storageId: file })).toEqual({ ok: true });

    expect((await row(t, id))?.receiptStorageId).toBe(file);
    expect(typeof (await owner.query(api.expenses.get, { id })).receiptUrl).toBe("string");
    const [listed] = (await owner.query(api.expenses.list, { paginationOpts: page(10) })).page;
    expect(listed.hasReceipt).toBe(true);
  });

  test("attaching the same file again is a no-op", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const file = await store(t);
    await owner.mutation(api.expenses.attachReceipt, { id, storageId: file });
    expect(await owner.mutation(api.expenses.attachReceipt, { id, storageId: file })).toEqual({ ok: true });
    expect(await exists(t, file)).toBe(true);
  });

  test("a new receipt replaces the old one and deletes its file", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const first = await store(t, "first");
    const second = await store(t, "second");
    await owner.mutation(api.expenses.attachReceipt, { id, storageId: first });
    await owner.mutation(api.expenses.attachReceipt, { id, storageId: second });
    expect((await row(t, id))?.receiptStorageId).toBe(second);
    expect(await exists(t, first)).toBe(false);
    expect(await exists(t, second)).toBe(true);
  });

  test("detaching clears the receipt and deletes the file", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const file = await store(t);
    await owner.mutation(api.expenses.attachReceipt, { id, storageId: file });
    await owner.mutation(api.expenses.detachReceipt, { id });
    expect((await row(t, id))?.receiptStorageId).toBeUndefined();
    expect(await exists(t, file)).toBe(false);
    // Detaching again is harmless.
    await owner.mutation(api.expenses.detachReceipt, { id });
  });

  test("a file of the wrong type is refused and deleted, and the expense is unchanged", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const file = await store(t, "<html>", "text/html");
    const result = await owner.mutation(api.expenses.attachReceipt, { id, storageId: file });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("JPG, PNG") });
    expect(await exists(t, file)).toBe(false);
    expect((await row(t, id))?.receiptStorageId).toBeUndefined();
  });

  test("a file over 10 MB is refused and deleted", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const file = await store(t, new Uint8Array(MAX_RECEIPT_BYTES + 1));
    expect(await owner.mutation(api.expenses.attachReceipt, { id, storageId: file })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("10 MB"),
    });
    expect(await exists(t, file)).toBe(false);
  });

  test("a bad file does not disturb the receipt already attached", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const good = await store(t);
    await owner.mutation(api.expenses.attachReceipt, { id, storageId: good });
    const bad = await store(t, "x", "application/zip");
    await owner.mutation(api.expenses.attachReceipt, { id, storageId: bad });
    expect((await row(t, id))?.receiptStorageId).toBe(good);
    expect(await exists(t, good)).toBe(true);
  });

  test("a file that no longer exists cannot be attached", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const file = await store(t);
    await t.run((ctx) => ctx.storage.delete(file));
    await expect(owner.mutation(api.expenses.attachReceipt, { id, storageId: file })).rejects.toMatchObject({
      data: { code: "INVALID_INPUT", field: "receipt" },
    });
  });

  test("another org cannot attach a receipt it does not own, nor read it", async () => {
    const { t, owner, bob } = setup();
    const { id: mine } = await newExpense(owner);
    const { id: bobs } = await newExpense(bob);
    const file = await store(t, "confidential");
    await owner.mutation(api.expenses.attachReceipt, { id: mine, storageId: file });

    // Bob knows the storage id but it is already claimed: refused, and the
    // file is left exactly as it was.
    const stolen = await bob
      .mutation(api.expenses.attachReceipt, { id: bobs, storageId: file })
      .catch((e) => e.data);
    expect(stolen).toMatchObject({ code: "INVALID_INPUT", field: "receipt" });
    expect((await row(t, bobs))?.receiptStorageId).toBeUndefined();
    expect((await row(t, mine))?.receiptStorageId).toBe(file);
    expect(await exists(t, file)).toBe(true);

    // Bob cannot get a URL for Alice's expense either.
    await expect(bob.query(api.expenses.get, { id: mine })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
  });

  test("a claimed file and a missing one are refused with the same answer", async () => {
    const { t, owner, bob } = setup();
    const { id: mine } = await newExpense(owner);
    const { id: bobs } = await newExpense(bob);
    const claimed = await store(t);
    await owner.mutation(api.expenses.attachReceipt, { id: mine, storageId: claimed });
    const missing = await store(t);
    await t.run((ctx) => ctx.storage.delete(missing));

    const a = await bob.mutation(api.expenses.attachReceipt, { id: bobs, storageId: claimed }).catch((e) => e.data);
    const b = await bob.mutation(api.expenses.attachReceipt, { id: bobs, storageId: missing }).catch((e) => e.data);
    expect(a).toEqual(b);
  });

  test("one org cannot attach a file to another org's expense", async () => {
    const { t, owner, bob } = setup();
    const { id: bobs } = await newExpense(bob);
    const file = await store(t);
    await expect(owner.mutation(api.expenses.attachReceipt, { id: bobs, storageId: file })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
    await expect(owner.mutation(api.expenses.detachReceipt, { id: bobs })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
  });

  test("a viewer cannot attach or detach", async () => {
    const { t, owner, viewer } = setup();
    const { id } = await newExpense(owner);
    const file = await store(t);
    const forbidden = { data: { code: "FORBIDDEN" } };
    await expect(viewer.mutation(api.expenses.attachReceipt, { id, storageId: file })).rejects.toMatchObject(forbidden);
    await expect(viewer.mutation(api.expenses.detachReceipt, { id })).rejects.toMatchObject(forbidden);
  });

  test("get copes with a receipt whose file has gone missing", async () => {
    const { t, owner } = setup();
    const { id } = await newExpense(owner);
    const file = await store(t);
    await owner.mutation(api.expenses.attachReceipt, { id, storageId: file });
    await t.run((ctx) => ctx.storage.delete(file));
    expect((await owner.query(api.expenses.get, { id })).receiptUrl).toBeNull();
  });

  test("a receipt's file is deleted with its expense, so it cannot be attached elsewhere", async () => {
    const { t, owner, bob } = setup();
    const { id: a } = await newExpense(owner);
    const file = await store(t);
    await owner.mutation(api.expenses.attachReceipt, { id: a, storageId: file });
    await owner.mutation(api.expenses.remove, { id: a });
    // The file itself was deleted with the expense, so it is simply gone.
    const { id: b } = await newExpense(bob);
    await expect(bob.mutation(api.expenses.attachReceipt, { id: b, storageId: file })).rejects.toMatchObject({
      data: { field: "receipt" },
    });
  });
});

test("startOfUtcDay is what dates are snapped to", () => {
  expect(startOfUtcDay(Date.UTC(2026, 0, 5, 23, 59))).toBe(Date.UTC(2026, 0, 5));
});
