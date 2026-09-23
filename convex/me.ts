import { capabilitiesForRole } from "./lib/scope";
import { scopedQuery } from "./lib/functions";

/**
 * Role and capabilities for the current scope, for role-aware nav and UI
 * gating. Never load-bearing for security — every write re-derives the scope
 * from the JWT and checks its own capability independently (see
 * convex/lib/scope.ts). This exists so the client can decide what to *show*,
 * not what to *allow*.
 */
export const getCurrentScope = scopedQuery({
  args: {},
  handler: async (ctx) => {
    return {
      scopeId: ctx.scope.scopeId,
      scopeKind: ctx.scope.scopeKind,
      role: ctx.scope.role,
      capabilities: capabilitiesForRole(ctx.scope.role),
    };
  },
});
