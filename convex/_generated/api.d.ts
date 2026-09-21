/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as audit from "../audit.js";
import type * as clients from "../clients.js";
import type * as expenseCategories from "../expenseCategories.js";
import type * as expenses from "../expenses.js";
import type * as http from "../http.js";
import type * as lib_clerkEvents from "../lib/clerkEvents.js";
import type * as lib_clientInput from "../lib/clientInput.js";
import type * as lib_currency from "../lib/currency.js";
import type * as lib_dates from "../lib/dates.js";
import type * as lib_entitlements from "../lib/entitlements.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_expenseInput from "../lib/expenseInput.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_period from "../lib/period.js";
import type * as lib_plans from "../lib/plans.js";
import type * as lib_receipts from "../lib/receipts.js";
import type * as lib_scope from "../lib/scope.js";
import type * as lib_scopeDefaults from "../lib/scopeDefaults.js";
import type * as lib_tables from "../lib/tables.js";
import type * as lib_triggers from "../lib/triggers.js";
import type * as lib_validators from "../lib/validators.js";
import type * as sync from "../sync.js";
import type * as usage from "../usage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  audit: typeof audit;
  clients: typeof clients;
  expenseCategories: typeof expenseCategories;
  expenses: typeof expenses;
  http: typeof http;
  "lib/clerkEvents": typeof lib_clerkEvents;
  "lib/clientInput": typeof lib_clientInput;
  "lib/currency": typeof lib_currency;
  "lib/dates": typeof lib_dates;
  "lib/entitlements": typeof lib_entitlements;
  "lib/errors": typeof lib_errors;
  "lib/expenseInput": typeof lib_expenseInput;
  "lib/functions": typeof lib_functions;
  "lib/period": typeof lib_period;
  "lib/plans": typeof lib_plans;
  "lib/receipts": typeof lib_receipts;
  "lib/scope": typeof lib_scope;
  "lib/scopeDefaults": typeof lib_scopeDefaults;
  "lib/tables": typeof lib_tables;
  "lib/triggers": typeof lib_triggers;
  "lib/validators": typeof lib_validators;
  sync: typeof sync;
  usage: typeof usage;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
