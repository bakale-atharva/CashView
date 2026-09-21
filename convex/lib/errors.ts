import { ConvexError } from "convex/values";
import type { Value } from "convex/values";

/** What a form turns into an inline message next to the named field. */
export type InvalidInput = { code: "INVALID_INPUT"; field: string; message: string };

export const invalidInput = (field: string, message: string) =>
  new ConvexError<InvalidInput>({ code: "INVALID_INPUT", field, message });

/** The record is in a state that does not allow this action. */
export const conflict = (reason: string, details: Record<string, Value> = {}) =>
  new ConvexError({ code: "CONFLICT", reason, ...details });
