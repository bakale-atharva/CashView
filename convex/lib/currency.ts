import type { DatabaseReader } from "../_generated/server";
import { requireFeature } from "./entitlements";
import { invalidInput } from "./errors";
import { getScopeSettings } from "./scopeDefaults";
import type { Scope } from "./validators";

type Ctx = { db: DatabaseReader; scope: Scope };

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** An ISO 4217 code, upper-cased; anything else is INVALID_INPUT. */
export function normalizeCurrencyCode(value: string, field = "currency"): string {
  const code = value.trim().toUpperCase();
  if (!CURRENCY_CODE.test(code)) {
    throw invalidInput(field, "Use a three-letter currency code, such as USD.");
  }
  return code;
}

/** Like `normalizeCurrencyCode`, but omitted or blank means "not set". */
export function optionalCurrencyCode(value: string | undefined, field = "currency"): string | undefined {
  return value?.trim() ? normalizeCurrencyCode(value, field) : undefined;
}

/** The scope's default currency: what a client without its own uses. */
export async function baseCurrency(ctx: Ctx): Promise<string> {
  const settings = await getScopeSettings(ctx, ctx.scope.scopeId);
  return settings?.currency ?? "USD";
}

/** Invoicing a client in another currency is the Business-tier feature. */
export async function requireCurrencyAllowed(ctx: Ctx, currency: string): Promise<void> {
  if (currency !== (await baseCurrency(ctx))) {
    await requireFeature(ctx, "multi_currency");
  }
}
