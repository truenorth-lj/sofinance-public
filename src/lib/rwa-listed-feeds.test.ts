import { describe, expect, it } from "vitest";
import { isMeteoraRwaListEnabled } from "./protocol-flags";
import { listedSolanaFeedKeys } from "./rwa-listed-feeds";

describe("listedSolanaFeedKeys", () => {
  it("is the Raydium feed only in production, plus the Meteora scan feed where listing is on", () => {
    expect(listedSolanaFeedKeys("production")).toEqual(["raydium-clmm-rwa-v1"]);
    for (const target of ["preview", "development"] as const) {
      expect(listedSolanaFeedKeys(target)).toEqual(isMeteoraRwaListEnabled(target)
        ? ["raydium-clmm-rwa-v1", "meteora-dlmm-rwa-v1"] : ["raydium-clmm-rwa-v1"]);
    }
  });
});
