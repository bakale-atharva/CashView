import { v } from "convex/values";
import { DAY_MS, startOfUtcDay } from "./dates";
import { invalidInput } from "./errors";

/**
 * The editable fields of an expense, as the client sends them. The receipt and
 * its scan status have their own functions, so an edit can never clear them.
 */
export const vExpenseInput = {
  categoryId: v.id("expenseCategories"),
  vendor: v.string(),
  description: v.optional(v.string()),
  /** The full amount paid, tax included. */
  amountCents: v.number(),
  /** The part of `amountCents` that was tax. */
  taxCents: v.optional(v.number()),
  /** ISO 4217 code. Defaults to the scope's base currency. */
  currency: v.optional(v.string()),
  spentAt: v.number(),
  paymentMethod: v.string(),
  isBillable: v.optional(v.boolean()),
  clientId: v.optional(v.id("clients")),
};

const MAX_CENTS = 1e12;
const CURRENCY = /^[A-Z]{3}$/;

export type NormalizedExpense = {
  vendor: string;
  description?: string;
  amountCents: number;
  taxCents: number;
  currency?: string;
  spentAt: number;
  paymentMethod: string;
  isBillable: boolean;
};

function text(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed === "") throw invalidInput(field, "This field is required.");
  if (trimmed.length > max) throw invalidInput(field, `Must be ${max} characters or fewer.`);
  return trimmed;
}

/**
 * Cleans and validates expense input, throwing a typed INVALID_INPUT that
 * names the field. `now` only bounds how far ahead an expense may be dated.
 */
export function normalizeExpenseInput(
  input: {
    vendor: string;
    description?: string;
    amountCents: number;
    taxCents?: number;
    currency?: string;
    spentAt: number;
    paymentMethod: string;
    isBillable?: boolean;
    clientId?: unknown;
  },
  now: number,
): NormalizedExpense {
  const { amountCents } = input;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > MAX_CENTS) {
    throw invalidInput("amountCents", "Enter an amount above zero, in whole cents.");
  }
  const taxCents = input.taxCents ?? 0;
  if (!Number.isSafeInteger(taxCents) || taxCents < 0) {
    throw invalidInput("taxCents", "Enter the tax in whole cents.");
  }
  if (taxCents > amountCents) {
    throw invalidInput("taxCents", "The tax cannot be more than the amount.");
  }

  const { spentAt } = input;
  if (!Number.isFinite(spentAt) || spentAt < 0) {
    throw invalidInput("spentAt", "Enter a valid date.");
  }
  if (spentAt > now + DAY_MS) {
    throw invalidInput("spentAt", "The date cannot be in the future.");
  }

  const currency = input.currency?.trim().toUpperCase();
  if (currency && !CURRENCY.test(currency)) {
    throw invalidInput("currency", "Use a three-letter currency code, such as USD.");
  }

  const isBillable = input.isBillable ?? false;
  if (isBillable && input.clientId === undefined) {
    throw invalidInput("clientId", "Choose the client this expense will be billed to.");
  }

  const description = input.description?.trim() || undefined;
  if (description !== undefined && description.length > 1000) {
    throw invalidInput("description", "Must be 1000 characters or fewer.");
  }

  return {
    vendor: text(input.vendor, "vendor", 200),
    description,
    amountCents,
    taxCents,
    currency: currency || undefined,
    spentAt: startOfUtcDay(spentAt),
    paymentMethod: text(input.paymentMethod, "paymentMethod", 50),
    isBillable,
  };
}

/** Category names: 1 to 60 characters. */
export function normalizeCategoryName(name: string): string {
  return text(name, "name", 60);
}

export const MAX_CATEGORIES = 100;
