import { defineApp } from "convex/server";
import { v } from "convex/values";

// Declared here so they are typed on `env` (from ./_generated/server). Set
// them in the Convex dashboard, not in .env.local or Vercel.
const app = defineApp({
  env: {
    // Clerk issuer domain. Also read by auth.config.ts.
    CLERK_FRONTEND_API_URL: v.optional(v.string()),
    // Signing secret of the Clerk webhook endpoint (B3).
    CLERK_WEBHOOK_SECRET: v.optional(v.string()),
    // Key for OpenRouter, which runs receipt scanning (Business plan).
    OPENROUTER_API_KEY: v.optional(v.string()),
  },
});

export default app;
