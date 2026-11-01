import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { readFileSync } from "node:fs";

// DEX boundary (DESIGN: shared DexAdapter registry). UI, routes, server use cases, MCP and the cron job reach a DEX
// only through `@/lib/dex` / `@/lib/dex/client`. Files frozen in the shrink-only baseline are exempt until migrated;
// src/lib/architecture-dex-boundaries.test.ts enforces the same rule on relative paths and keeps the baseline shrinking.
const dexBaseline = JSON.parse(readFileSync(new URL("./src/lib/architecture-dex-baseline.json", import.meta.url), "utf8"));
const dexBaselineFiles = Object.keys(dexBaseline.imports);
const dexRegistryOnlyFiles = ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}", "src/server/**/*.{ts,tsx}", "src/mcp/**/*.{ts,tsx}", "src/lib/rwa-refresh*.ts"];
const dexImportPattern = {
  group: [
    "@raydium-io/*", "@meteora-ag/*", "@orca-so/*", "@uniswap/*",
    "@sofinance/engine/protocols/**", "@sofinance/engine/open-atomic", "@sofinance/engine/compound-atomic", "@sofinance/engine/open-state",
    "@sofinance/engine/open-quote", "@sofinance/engine/selected-state", "@sofinance/engine/lp-exit", "@sofinance/engine/wallet-discovery",
    "@/lib/dex/*", "!@/lib/dex/client", "!@/lib/dex/types", "!@/lib/dex/errors", "@/lib/dex/*/**",
    "@/lib/meteora-*", "@/lib/meteora-wallet/**", "@/lib/orca-*", "@/lib/rhc-univ4-*", "@/lib/rhc-position-*",
    "@/lib/rhc-range-apr*", "@/lib/rhc-apr-refresh", "@/lib/rhc-snapshot", "@/lib/pool-sources/*", "!@/lib/pool-sources/types",
  ],
  message: "Reach DEXes through the @/lib/dex registry (descriptors, capabilities, adapters), not a DEX module or SDK. See src/lib/architecture-dex-boundaries.test.ts.",
};
const transportImportPattern = { group: ["@/app/**", "@/mcp/**", "@/components/**", "next", "next/**", "react", "react/**", "react-dom", "react-dom/**", "@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/**"],
  message: "Prepare use cases cannot depend on transport or UI adapters. The AST guard also checks relative paths and barrels." };

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["src/server/transactions/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [transportImportPattern],
      }],
    },
  },
  {
    files: dexRegistryOnlyFiles,
    ignores: ["**/*.test.{ts,tsx}", "src/server/transactions/**", ...dexBaselineFiles],
    rules: { "no-restricted-imports": ["error", { patterns: [dexImportPattern] }] },
  },
  {
    // Flat config replaces rule options per file, so use-case files carry both restrictions.
    files: ["src/server/transactions/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}", ...dexBaselineFiles],
    rules: { "no-restricted-imports": ["error", { patterns: [transportImportPattern, dexImportPattern] }] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "scripts/**",
    "e2e/**",
  ]),
]);

export default eslintConfig;
