import { ConvexError } from "convex/values";
import type { Value } from "convex/values";

/** What a form turns into an inline message next to the named field. */
export type InvalidInput = { code: "INVALID_INPUT"; field: string; message: string };

export const invalidInput = (field: string, message: string) =>
  new ConvexError<InvalidInput>({ code: "INVALID_INPUT", field, message });

/** The record is in a state that does not allow this action. */
export const conflict = (reason: string, details: Record<string, Value> = {}) =>
  new ConvexError({ code: "CONFLICT", reason, ...details });

/** Trims; an empty or blank optional value means "not set". */
export function optionalText(value: string | undefined, field: string, max: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw invalidInput(field, `Must be ${max} characters or fewer.`);
  return trimmed;
}

/** Trims, then insists on something being left. */
export function requiredText(value: string, field: string, max: number): string {
  const trimmed = optionalText(value, field, max);
  if (trimmed === undefined) throw invalidInput(field, "This field is required.");
  return trimmed;
}
