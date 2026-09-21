import { describe, expect, test } from "vitest";
import { DAY_MS, startOfUtcDay } from "./invoiceMath";
import { looksLikePublicToken, mintPublicToken } from "./publicToken";
import {
  PAYABLE,
  assertTransition,
  canTransition,
  isPastDue,
  statusAfterPaymentChange,
} from "./invoiceStatus";
import type { InvoiceStatus } from "./validators";

const ALL: InvoiceStatus[] = ["draft", "sent", "viewed", "paid", "overdue", "void"];

describe("transitions", () => {
  test.each([
    ["draft", ["sent"]],
    ["sent", ["viewed", "paid", "overdue", "void"]],
    ["viewed", ["paid", "overdue", "void"]],
    ["overdue", ["paid", "void"]],
    ["paid", ["sent", "viewed", "overdue"]],
    ["void", []],
  ] as const)("from %s only to %j", (from, allowed) => {
    for (const to of ALL) {
      expect(canTransition(from, to)).toBe(allowed.includes(to as never));
    }
  });

  test("void is terminal", () => {
    for (const to of ALL) expect(canTransition("void", to)).toBe(false);
  });

  test("an illegal transition throws a typed error", () => {
    expect(() => assertTransition("draft", "paid")).toThrow(
      expect.objectContaining({
        data: { code: "INVALID_TRANSITION", from: "draft", to: "paid" },
      }),
    );
    expect(() => assertTransition("draft", "sent")).not.toThrow();
  });

  test("a payment can only be recorded on an open invoice", () => {
    expect([...PAYABLE].sort()).toEqual(["overdue", "sent", "viewed"]);
  });
});

describe("isPastDue", () => {
  const due = Date.UTC(2026, 8, 20);
  test("the due day itself is not overdue; the day after is", () => {
    expect(isPastDue(due, Date.UTC(2026, 8, 20, 23, 59, 59))).toBe(false);
    expect(isPastDue(due, Date.UTC(2026, 8, 21, 0, 0, 0))).toBe(true);
  });
  test("consistent with startOfUtcDay", () => {
    expect(isPastDue(startOfUtcDay(Date.now()) - DAY_MS, Date.now())).toBe(true);
  });
});

describe("statusAfterPaymentChange", () => {
  const NOW = Date.UTC(2026, 8, 21, 12);
  const future = NOW + 10 * DAY_MS;
  const past = NOW - 10 * DAY_MS;
  const inv = (over: Partial<Parameters<typeof statusAfterPaymentChange>[0]> = {}) => ({
    status: "sent" as InvoiceStatus,
    totalCents: 10_000,
    paidCents: 0,
    dueDate: future,
    ...over,
  });

  test("covered in full becomes paid, from any open status", () => {
    for (const status of ["sent", "viewed", "overdue"] as const) {
      expect(statusAfterPaymentChange(inv({ status, paidCents: 10_000 }), NOW)).toBe("paid");
    }
  });

  test("a partial payment changes nothing", () => {
    for (const status of ["sent", "viewed", "overdue"] as const) {
      expect(statusAfterPaymentChange(inv({ status, paidCents: 4_000 }), NOW)).toBeNull();
    }
  });

  test("already paid and still covered stays put", () => {
    expect(statusAfterPaymentChange(inv({ status: "paid", paidCents: 10_000 }), NOW)).toBeNull();
  });

  test("a paid invoice that is no longer covered reopens to the right status", () => {
    expect(statusAfterPaymentChange(inv({ status: "paid", paidCents: 0 }), NOW)).toBe("sent");
    expect(
      statusAfterPaymentChange(inv({ status: "paid", paidCents: 0, viewedAt: 1 }), NOW),
    ).toBe("viewed");
    expect(
      statusAfterPaymentChange(inv({ status: "paid", paidCents: 3_000, dueDate: past, viewedAt: 1 }), NOW),
    ).toBe("overdue");
  });

  test("drafts and voided invoices never move", () => {
    expect(statusAfterPaymentChange(inv({ status: "draft", paidCents: 10_000 }), NOW)).toBeNull();
    expect(statusAfterPaymentChange(inv({ status: "void", paidCents: 10_000 }), NOW)).toBeNull();
  });

  test("a zero-total invoice is never 'covered'", () => {
    expect(statusAfterPaymentChange(inv({ totalCents: 0, paidCents: 0 }), NOW)).toBeNull();
  });
});

describe("public token", () => {
  test("is 43 URL-safe characters", () => {
    const token = mintPublicToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(looksLikePublicToken(token)).toBe(true);
  });

  test("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 500 }, mintPublicToken));
    expect(tokens.size).toBe(500);
  });

  test.each(["", "abc", "x".repeat(42), "x".repeat(44), `${"a".repeat(42)}=`, `${"a".repeat(42)}/`, `${"a".repeat(42)} `])(
    "%j is not a token",
    (value) => {
      expect(looksLikePublicToken(value)).toBe(false);
    },
  );
});
