/**
 * Which tables scoped functions may touch, and how. This is the single list
 * behind both the row-level-security rules (functions.ts) and the scope guard
 * triggers (triggers.ts), so a new tenant table cannot be added to one and
 * forgotten in the other.
 *
 * Not listed, therefore denied to scoped functions entirely: `users` and
 * `organizations` (global, cross-tenant).
 */

/** Tenant tables that scoped mutations may insert into, patch and delete from. */
export const WRITABLE_TENANT_TABLES = [
  "scopeSettings",
  "clients",
  "invoices",
  "invoiceLineItems",
  "payments",
  "recurringInvoices",
  "recurringLineItems",
  "expenses",
  "expenseCategories",
] as const;

/**
 * Tenant tables that scoped functions may read but never write. They are
 * written by webhook handlers (memberships, subscriptions) or by triggers
 * (usageCounters, auditLogs).
 */
export const READ_ONLY_TENANT_TABLES = [
  "usageCounters",
  "auditLogs",
  "memberships",
  "subscriptions",
] as const;

export type WritableTenantTable = (typeof WRITABLE_TENANT_TABLES)[number];
export type ReadOnlyTenantTable = (typeof READ_ONLY_TENANT_TABLES)[number];
export type TenantTable = WritableTenantTable | ReadOnlyTenantTable;
