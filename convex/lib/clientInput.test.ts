import { describe, expect, test } from "vitest";
import { normalizeClientInput } from "./clientInput";

const invalid = (field: string) =>
  expect.objectContaining({ data: expect.objectContaining({ code: "INVALID_INPUT", field }) });

describe("normalizeClientInput", () => {
  test("trims and keeps a valid client", () => {
    expect(
      normalizeClientInput({
        name: "  Acme Inc.  ",
        company: " Acme ",
        email: " billing@acme.com ",
        phone: "+1 (555) 010-2030",
        notes: " Net 30 ",
        currency: " eur ",
      }),
    ).toEqual({
      name: "Acme Inc.",
      company: "Acme",
      email: "billing@acme.com",
      phone: "+1 (555) 010-2030",
      billingAddress: undefined,
      notes: "Net 30",
      currency: "EUR",
    });
  });

  test("blank optional fields become undefined, which clears them on update", () => {
    const out = normalizeClientInput({ name: "A", company: "  ", email: "", notes: "\n" });
    expect(out.company).toBeUndefined();
    expect(out.email).toBeUndefined();
    expect(out.notes).toBeUndefined();
  });

  test.each([["", "name"], ["   ", "name"]])("name %j is required", (name, field) => {
    expect(() => normalizeClientInput({ name })).toThrow(invalid(field));
  });

  test.each(["nope", "a@b", "a b@c.com", "@c.com", "a@@c.com"])(
    "email %j is rejected",
    (email) => {
      expect(() => normalizeClientInput({ name: "A", email })).toThrow(invalid("email"));
    },
  );

  test.each(["abc", "12", "555-CALL-NOW"])("phone %j is rejected", (phone) => {
    expect(() => normalizeClientInput({ name: "A", phone })).toThrow(invalid("phone"));
  });

  test.each(["US", "USDX", "12A", "€"])("currency %j is rejected", (currency) => {
    expect(() => normalizeClientInput({ name: "A", currency })).toThrow(invalid("currency"));
  });

  test("length limits are enforced per field", () => {
    expect(() => normalizeClientInput({ name: "x".repeat(201) })).toThrow(invalid("name"));
    expect(() => normalizeClientInput({ name: "A", notes: "x".repeat(5001) })).toThrow(
      invalid("notes"),
    );
  });

  test("a billing address needs line 1, city and country; the rest is optional", () => {
    const base = { name: "A" };
    expect(() =>
      normalizeClientInput({
        ...base,
        billingAddress: { line1: " ", city: "Pune", country: "IN" },
      }),
    ).toThrow(invalid("billingAddress.line1"));
    expect(() =>
      normalizeClientInput({
        ...base,
        billingAddress: { line1: "1 Main St", city: "", country: "IN" },
      }),
    ).toThrow(invalid("billingAddress.city"));
    expect(
      normalizeClientInput({
        ...base,
        billingAddress: { line1: " 1 Main St ", line2: " ", city: "Pune", country: "IN" },
      }).billingAddress,
    ).toEqual({
      line1: "1 Main St",
      line2: undefined,
      city: "Pune",
      region: undefined,
      postalCode: undefined,
      country: "IN",
    });
  });
});
