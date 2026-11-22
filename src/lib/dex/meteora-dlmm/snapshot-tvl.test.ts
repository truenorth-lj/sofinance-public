import { describe, expect, it } from "vitest";
import { SPL_TOKEN_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import { feedRowTvlMints, meteoraSnapshotTvl } from "./snapshot-tvl";

const NVDAX = { multiplier: 1.000918, newMultiplier: 1.001701196801074, newMultiplierEffectiveTimestamp: 1_789_000_200 };
const NOW = Date.parse("2026-11-22T04:00:00Z");
// NVDA/NVDAx as datapi publishes it (X3-7 capture): reserves as raw / 10^decimals, USD per share.
const snapshot = { tvlUsd: 39_347.15, tvlSides: { amountX: 90.63, amountY: 218.23, priceUsdX: 127.41, priceUsdY: 127.61 } };

describe("meteoraSnapshotTvl", () => {
  it("adds the multiplier part from the scan's mint read, at the given clock", () => {
    const result = meteoraSnapshotTvl(snapshot, feedRowTvlMints({ tvlScaledUi: { mintsRead: true }, scaledUiConfigB: NVDAX }), NOW);
    expect(result).toMatchObject({ kind: "corrected", sourceTvlUsd: 39_347.15 });
    expect(result!.tvlUsd).toBeCloseTo(39_347.15 + 218.23 * 0.001701196801074 * 127.61, 9);
  });
  it("keeps the published TVL, unverified, when the mints were not read (never treated as 1)", () => {
    for (const mints of [undefined, feedRowTvlMints({ tvlScaledUi: { mintsRead: false }, scaledUiConfigB: NVDAX }), feedRowTvlMints({})])
      expect(meteoraSnapshotTvl(snapshot, mints, NOW)).toMatchObject({ kind: "unverified", tvlUsd: 39_347.15, reason: "multiplier-unknown" });
  });
  it("an SPL Token side is 1 without a read, with or without token amounts", () => {
    const spl = { mintsRead: false, tokenProgramX: SPL_TOKEN_PROGRAM_ID, tokenProgramY: SPL_TOKEN_PROGRAM_ID };
    expect(meteoraSnapshotTvl(snapshot, spl, NOW)).toEqual({ kind: "corrected", tvlUsd: 39_347.15, sourceTvlUsd: 39_347.15 });
    expect(meteoraSnapshotTvl({ tvlUsd: 1_000 }, spl, NOW)).toEqual({ kind: "corrected", tvlUsd: 1_000, sourceTvlUsd: 1_000 });
    // One side SPL, the other unknown: still unverified.
    expect(meteoraSnapshotTvl({ tvlUsd: 1_000 }, { mintsRead: false, tokenProgramX: SPL_TOKEN_PROGRAM_ID }, NOW)).toMatchObject({ kind: "unverified" });
  });
  it("is null when datapi gave no TVL", () => {
    expect(meteoraSnapshotTvl({ tvlUsd: null }, undefined, NOW)).toBeNull();
  });
});
