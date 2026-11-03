import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// DEX boundary (DESIGN: shared DexAdapter registry). UI, routes, server use cases, MCP and the cron job reach a DEX
// only through `@/lib/dex` / `@/lib/dex/client`. Files frozen in the shrink-only baseline are exempt until migrated;
// src/lib/architecture-dex-boundaries.test.ts enforces the same rule on relative paths and keeps the baseline shrinking.
const dexBaseline = JSON.parse(readFileSync(new URL("./src/lib/architecture-dex-baseline.json", import.meta.url), "utf8"));
const dexBaselineFiles = Object.keys(dexBaseline.imports);
const dexRegistryOnlyFiles = ["src/app/**/*.{ts,tsx}", "src/server/**/*.{ts,tsx}", "src/mcp/**/*.{ts,tsx}", "src/lib/rwa-refresh*.ts"];
const componentFiles = ["src/components/**/*.{ts,tsx}"];
const dexSdkGroup = ["@raydium-io/*", "@meteora-ag/*", "@orca-so/*", "@uniswap/*"];
// Engine and lib modules that are one DEX's code. The AST guard additionally auto-classifies any lib/engine module with
// a runtime DEX SDK or `protocols/<dex>/` import and follows `export … from` chains; ESLint cannot, so keep this in sync.
const dexModuleGroup = [
  ...dexSdkGroup,
  "@sofinance/engine/protocols/**", "@sofinance/engine/open-atomic", "@sofinance/engine/compound-atomic", "@sofinance/engine/compound-state",
  "@sofinance/engine/compound-recovery-import", "@sofinance/engine/open-state", "@sofinance/engine/open-quote", "@sofinance/engine/open-range",
  "@sofinance/engine/selected-state", "@sofinance/engine/lp-exit", "@sofinance/engine/lp-exit-data", "@sofinance/engine/wallet-discovery",
  "@/lib/meteora-*", "@/lib/meteora-wallet/**", "@/lib/orca-*", "@/lib/rhc-univ4-*", "@/lib/rhc-position-*",
  "@/lib/rhc-range-apr*", "@/lib/rhc-apr-refresh", "@/lib/rhc-snapshot", "@/lib/pool-sources/*", "!@/lib/pool-sources/types",
  "@/lib/rhc-wallet/open-execute", "@/lib/rhc-wallet/exit-execute", "@/lib/rhc-wallet/open-steps", "@/lib/rhc-wallet/open-attempt",
  "@/lib/rhc-wallet/pool-view",
];
const dexMessage = "Reach DEXes through the @/lib/dex registry (descriptors, capabilities, adapters), not a DEX module or SDK. See src/lib/architecture-dex-boundaries.test.ts.";
const dexImportPattern = {
  group: [...dexModuleGroup, "@/lib/dex/*", "!@/lib/dex/client", "!@/lib/dex/types", "!@/lib/dex/errors", "@/lib/dex/*/**"],
  message: dexMessage,
};
// Client components may take only the browser-safe entry point; `@/lib/dex` itself (registry, server adapters) is off limits.
const componentDexEntryMessage = "Components import only @/lib/dex/client, never @/lib/dex or its internals.";
const componentDexEntry = {
  paths: [{ name: "@/lib/dex", message: componentDexEntryMessage }],
  patterns: [{ group: ["@/lib/dex/*", "!@/lib/dex/client", "@/lib/dex/*/**"], message: componentDexEntryMessage }],
};
// Inside src/lib/dex: one DEX folder never imports another, and the shared entry points (client, registry, descriptors)
// see each DEX only through its module.ts / descriptor.ts. The AST guard also checks relative paths and client.ts reachability.
const dexDir = new URL("./src/lib/dex/", import.meta.url);
const dexFolders = existsSync(dexDir)
  ? readdirSync(dexDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== "__contract__").map((entry) => entry.name)
  : [];
const dexInternalConfigs = [
  ...dexFolders.map((folder) => ({
    files: [`src/lib/dex/${folder}/**/*.{ts,tsx}`],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [{
      regex: `^@/lib/dex/(?!${folder}/)[^/]+/`,
      message: `src/lib/dex/${folder} must not import another DEX folder or the contract test kit; share code through src/lib/dex/*.ts.`,
    }] }] },
  })),
  {
    files: ["src/lib/dex/{client,registry,descriptors}.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [
      { regex: "^(@/lib/dex|\\.)/[^/]+/(?!(module|descriptor)$)", message: "client/registry/descriptors may import only a DEX's module.ts or descriptor.ts." },
      { group: ["server-only", ...dexSdkGroup, "@sofinance/engine/protocols/**", "**/*.server"], message: "Shared DEX entry points stay browser-safe: no server-only, DEX SDK or adapter.server import." },
    ] }] },
  },
];
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
    files: componentFiles,
    ignores: ["**/*.test.{ts,tsx}", ...dexBaselineFiles],
    rules: { "no-restricted-imports": ["error", {
      paths: componentDexEntry.paths,
      patterns: [{ group: [...dexModuleGroup, "@/lib/dex/*", "!@/lib/dex/client", "@/lib/dex/*/**"], message: `${dexMessage} ${componentDexEntryMessage}` }],
    }] },
  },
  {
    // Baselined components keep their frozen DEX imports but still may not reach past @/lib/dex/client.
    files: dexBaselineFiles.filter((file) => file.startsWith("src/components/")),
    ignores: ["**/*.test.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", componentDexEntry] },
  },
  ...dexInternalConfigs,
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
