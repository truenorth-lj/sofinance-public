import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("app chrome copy", () => {
  it("describes Solana and Robinhood Chain, not Raydium only", () => {
    const layout = readFileSync(resolve("src/app/app/layout.tsx"), "utf8");
    const manifest = readFileSync(resolve("src/app/manifest.ts"), "utf8");
    const ai = readFileSync(resolve("src/app/app/ai/page.tsx"), "utf8");
    expect(layout).toContain("LP positions on Solana and Robinhood Chain");
    expect(layout).not.toContain("manage Raydium CLMM positions");
    expect(manifest).toContain("LP positions on Solana and Robinhood Chain");
    expect(manifest).not.toContain("manage your Raydium CLMM positions");
    expect(ai).toContain("list positions and pools");
    expect(ai).not.toContain("list positions and RWA pairs");
    expect(layout).not.toMatch(/same-stock/i);
    expect(manifest).not.toMatch(/same-stock/i);
  });
});
