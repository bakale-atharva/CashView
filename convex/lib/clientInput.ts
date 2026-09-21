import { ConvexError, v } from "convex/values";
import type { Infer } from "convex/values";
import { vAddress } from "./validators";

/**
 * The editable fields of a client, as the client sends them. Balances, the
 * archived flag and the scope are never accepted from a request.
 */
export const vClientInput = {
  name: v.string(),
  company: v.optional(v.string()),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  billingAddress: v.optional(vAddress),
  notes: v.optional(v.string()),
  /** ISO 4217 code. Defaults to the scope's base currency on create. */
  currency: v.optional(v.string()),
};

export const vClient = v.object(vClientInput);
export type ClientInput = Infer<typeof vClient>;
export type NormalizedClient = {
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  billingAddress?: Infer<typeof vAddress>;
  notes?: string;
  currency?: string;
};

export type InvalidInput = { code: "INVALID_INPUT"; field: string; message: string };

const invalid = (field: string, message: string) =>
  new ConvexError<InvalidInput>({ code: "INVALID_INPUT", field, message });

const LIMITS = {
  name: 200,
  company: 200,
  email: 254,
  phone: 40,
  notes: 5000,
  addressLine: 200,
  region: 100,
  postalCode: 30,
  country: 100,
} as const;

/** Trims; an empty or blank optional value means "not set". */
function optional(
  value: string | undefined,
  field: string,
  max: number,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw invalid(field, `Must be ${max} characters or fewer.`);
  return trimmed;
}

function required(value: string, field: string, max: number): string {
  const trimmed = optional(value, field, max);
  if (trimmed === undefined) throw invalid(field, "This field is required.");
  return trimmed;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Digits plus the punctuation people actually type; not a strict E.164 check.
const PHONE = /^[\d\s+().\-#xX]{3,40}$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Cleans and validates client input, throwing a typed INVALID_INPUT that
 * names the offending field so a form can show it inline. Optional fields
 * that are omitted or blank come back undefined, which clears them on update.
 */
export function normalizeClientInput(input: ClientInput): NormalizedClient {
  const email = optional(input.email, "email", LIMITS.email);
  if (email !== undefined && !EMAIL.test(email)) {
    throw invalid("email", "Enter a valid email address.");
  }

  const phone = optional(input.phone, "phone", LIMITS.phone);
  if (phone !== undefined && !PHONE.test(phone)) {
    throw invalid("phone", "Enter a valid phone number.");
  }

  const currency = input.currency?.trim().toUpperCase();
  if (currency !== undefined && currency !== "" && !CURRENCY.test(currency)) {
    throw invalid("currency", "Use a three-letter currency code, such as USD.");
  }

  let billingAddress: NormalizedClient["billingAddress"];
  if (input.billingAddress) {
    const a = input.billingAddress;
    billingAddress = {
      line1: required(a.line1, "billingAddress.line1", LIMITS.addressLine),
      line2: optional(a.line2, "billingAddress.line2", LIMITS.addressLine),
      city: required(a.city, "billingAddress.city", LIMITS.addressLine),
      region: optional(a.region, "billingAddress.region", LIMITS.region),
      postalCode: optional(a.postalCode, "billingAddress.postalCode", LIMITS.postalCode),
      country: required(a.country, "billingAddress.country", LIMITS.country),
    };
  }

  return {
    name: required(input.name, "name", LIMITS.name),
    company: optional(input.company, "company", LIMITS.company),
    email,
    phone,
    billingAddress,
    notes: optional(input.notes, "notes", LIMITS.notes),
    currency: currency || undefined,
  };
}
