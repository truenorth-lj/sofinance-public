import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("guide click-step pool names", () => {
  const src = readFileSync(resolve("src/lib/guides.ts"), "utf8");

  it("names pools in step lists as the cards do, and leaves guide titles as they are", () => {
    expect(src).toContain("Choose the Meteora or Raydium TSLAx/TSLA pool and press Open position.");
    expect(src).toContain("Choose a Raydium or Meteora SPCXx/SPCX pool and press Open position.");
    expect(src).toContain("pick a same-stock pool, for example TSLAx/TSLA or SPCXx/SPCX.");
    expect(src).not.toContain("Choose the Meteora or Raydium TSLA/TSLAx pool");
    expect(src).not.toContain("Choose a Raydium or Meteora SPCX/SPCXx pool");
    // H1s / titles keep the existing keyword order.
    expect(src).toContain("TSLA same-stock LP: TSLA/TSLAx pools on Meteora and Raydium");
    expect(src).toContain("SPCX same-stock LP: SPCX/SPCXx pools on Raydium and Meteora");
  });
});
