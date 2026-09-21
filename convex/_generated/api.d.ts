/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as http from "../http.js";
import type * as lib_clerkEvents from "../lib/clerkEvents.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_plans from "../lib/plans.js";
import type * as lib_scope from "../lib/scope.js";
import type * as lib_scopeDefaults from "../lib/scopeDefaults.js";
import type * as lib_tables from "../lib/tables.js";
import type * as lib_triggers from "../lib/triggers.js";
import type * as lib_validators from "../lib/validators.js";
import type * as sync from "../sync.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  http: typeof http;
  "lib/clerkEvents": typeof lib_clerkEvents;
  "lib/functions": typeof lib_functions;
  "lib/plans": typeof lib_plans;
  "lib/scope": typeof lib_scope;
  "lib/scopeDefaults": typeof lib_scopeDefaults;
  "lib/tables": typeof lib_tables;
  "lib/triggers": typeof lib_triggers;
  "lib/validators": typeof lib_validators;
  sync: typeof sync;
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
