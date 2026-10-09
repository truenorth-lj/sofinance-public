import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("BrowserWalletProvider", () => {
  it("leaves the wallets array empty so wallet-adapter-react auto-detects Wallet Standard wallets", () => {
    const src = readFileSync(resolve("src/components/providers.tsx"), "utf8");
    expect(src).toContain("useMemo(() => [], [])");
    expect(src).toMatch(/Wallet Standard/);
    expect(src).toContain("Passing those adapters would duplicate them");
  });
});
