import { describe, expect, it } from "vitest";
import { listedSolanaFeedKeys } from "./rwa-listed-feeds";

describe("listedSolanaFeedKeys", () => {
  it("is the Raydium feed plus the Meteora scan feed", () => {
    expect(listedSolanaFeedKeys()).toEqual(["raydium-clmm-rwa-v1", "meteora-dlmm-rwa-v1"]);
  });
});
