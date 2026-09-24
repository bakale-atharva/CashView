import { v } from "convex/values";
import type { DatabaseReader } from "./_generated/server";
import { invalidInput, optionalText as text } from "./lib/errors";
import { normalizeCurrencyCode } from "./lib/currency";
import { scopedMutation, scopedQuery } from "./lib/functions";
import { requireCapability } from "./lib/scope";
import { getScopeSettings } from "./lib/scopeDefaults";
import { vAddress } from "./lib/validators";
import type { Scope } from "./lib/validators";

/**
 * A scope's business identity, branding and invoice defaults (one row per
 * scope, created by `ensureScopeDefaults` when the scope is synced). Reading
 * it is available to any role that can read the books at all — the base
 * currency and invoice numbering are needed to render forms, not just to
 * administer the workspace — but only `settings.manage` (Owner/Admin) may
 * change it.
 */

const vSettingsInput = {
  businessName: v.optional(v.string()),
  address: v.optional(vAddress),
  email: v.optional(v.string()),
  phone: v.optional(v.string()),
  taxId: v.optional(v.string()),
  brandColor: v.optional(v.string()),
  invoiceTemplate: v.optional(v.string()),
  currency: v.string(),
  defaultTaxRatePct: v.number(),
  invoiceNumberPrefix: v.string(),
  paymentTermsDays: v.number(),
  footerNote: v.optional(v.string()),
};

async function requireSettings(ctx: { db: DatabaseReader; scope: Scope }) {
  const settings = await getScopeSettings(ctx, ctx.scope.scopeId);
  if (settings === null) throw new Error("scopeSettings missing for an active scope");
  return settings;
}

export const get = scopedQuery({
  args: {},
  handler: async (ctx) => {
    requireCapability(ctx.scope, "clients.read");
    const settings = await requireSettings(ctx);
    const logoUrl = settings.logoStorageId ? await ctx.storage.getUrl(settings.logoStorageId) : null;
    return { ...settings, logoUrl };
  },
});

export const update = scopedMutation({
  args: vSettingsInput,
  handler: async (ctx, args) => {
    requireCapability(ctx.scope, "settings.manage");
    const settings = await requireSettings(ctx);

    const currency = normalizeCurrencyCode(args.currency);
    const { defaultTaxRatePct, paymentTermsDays } = args;
    if (!Number.isFinite(defaultTaxRatePct) || defaultTaxRatePct < 0 || defaultTaxRatePct > 100) {
      throw invalidInput("defaultTaxRatePct", "Enter a rate from 0 to 100.");
    }
    if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > 365) {
      throw invalidInput("paymentTermsDays", "Enter a whole number of days from 0 to 365.");
    }
    const invoiceNumberPrefix = args.invoiceNumberPrefix.trim();
    if (invoiceNumberPrefix === "" || invoiceNumberPrefix.length > 20) {
      throw invalidInput("invoiceNumberPrefix", "Enter up to 20 characters.");
    }

    let address = undefined as typeof settings.address;
    if (args.address) {
      const a = args.address;
      const line1 = text(a.line1, "address.line1", 200);
      const city = text(a.city, "address.city", 200);
      const country = text(a.country, "address.country", 100);
      if (!line1 || !city || !country) {
        throw invalidInput("address", "Enter at least a street, city and country.");
      }
      address = {
        line1,
        line2: text(a.line2, "address.line2", 200),
        city,
        region: text(a.region, "address.region", 100),
        postalCode: text(a.postalCode, "address.postalCode", 30),
        country,
      };
    }

    await ctx.db.patch("scopeSettings", settings._id, {
      businessName: text(args.businessName, "businessName", 200),
      address,
      email: text(args.email, "email", 254),
      phone: text(args.phone, "phone", 40),
      taxId: text(args.taxId, "taxId", 50),
      brandColor: text(args.brandColor, "brandColor", 20),
      invoiceTemplate: text(args.invoiceTemplate, "invoiceTemplate", 40),
      currency,
      defaultTaxRatePct,
      invoiceNumberPrefix,
      paymentTermsDays,
      footerNote: text(args.footerNote, "footerNote", 1000),
    });
  },
});

/** A short-lived URL to upload a new logo to; pass the storage id to `attachLogo`. */
export const generateLogoUploadUrl = scopedMutation({
  args: {},
  handler: async (ctx) => {
    requireCapability(ctx.scope, "settings.manage");
    return await ctx.storage.generateUploadUrl();
  },
});

export const attachLogo = scopedMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    requireCapability(ctx.scope, "settings.manage");
    const settings = await requireSettings(ctx);
    const old = settings.logoStorageId;
    await ctx.db.patch("scopeSettings", settings._id, { logoStorageId: storageId });
    if (old) await ctx.storage.delete(old);
  },
});

export const removeLogo = scopedMutation({
  args: {},
  handler: async (ctx) => {
    requireCapability(ctx.scope, "settings.manage");
    const settings = await getScopeSettings(ctx, ctx.scope.scopeId);
    if (settings === null || !settings.logoStorageId) return;
    const old = settings.logoStorageId;
    await ctx.db.patch("scopeSettings", settings._id, { logoStorageId: undefined });
    await ctx.storage.delete(old);
  },
});
