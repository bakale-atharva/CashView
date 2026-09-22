import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-config-next sets react.version to "detect", which makes
  // eslint-plugin-react call context.getFilename() — removed in ESLint 10.
  // An explicit version skips detection entirely.
  { settings: { react: { version: "19.2.8" } } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent tooling and generated code
    ".agents/**",
    ".claude/**",
    "convex/_generated/**",
    ".impeccable/**",
    // Bklit UI ships chart source directly into the project via the shadcn
    // CLI (see PLAN.md A5); it isn't code we wrote or maintain the style of.
    "components/charts/**",
  ]),
]);

export default eslintConfig;
