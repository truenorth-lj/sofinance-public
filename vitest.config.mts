import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**", "packages/**"],
    // offline-fetch first: it must replace fetch before any library (e.g. @solana/web3.js) captures it at load time.
    // Tests that import engine modules directly get the same host configuration as the app.
    setupFiles: ["./src/lib/test-support/offline-fetch.ts", "./src/lib/engine-host.ts"],
    // Inline the engine so vi.mock("@sofinance/engine/x") also replaces the engine's own internal imports
    // (identical mocking semantics to when these modules lived in src/lib).
    server: { deps: { inline: [/@sofinance\/engine/] } },
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
