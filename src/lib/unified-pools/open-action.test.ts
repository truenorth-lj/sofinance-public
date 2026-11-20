import { describe, expect, it } from "vitest";
import { openAction } from "./open-action";
import type { UnifiedPool } from "./model";

const pool = (extra: Partial<UnifiedPool> & Pick<UnifiedPool, "protocol" | "poolAddress">): UnifiedPool => ({
  key: `${extra.chain ?? "solana"}:${extra.poolAddress}`,
  chain: "solana",
  pairLabel: "TSLAx/TSLA",
  symbolA: "TSLAx",
  symbolB: "TSLA",
  nameA: "TSLAx",
  nameB: "TSLA",
  mintA: "mint-a",
  mintB: "mint-b",
  feeTierBps: 25,
  tvlUsd: 50_000,
  volume24hUsd: 2_000,
  poolFeeApr24hPct: 12,
  ...extra,
});

describe("openAction", () => {
  it("deep-links a Raydium pool into ?openPool=", () => {
    expect(openAction(pool({ protocol: "raydium-clmm", poolAddress: "tsla-raydium" }))).toEqual({
      kind: "link",
      href: "/app/rwa-pairs?openPool=tsla-raydium",
    });
  });

  it("deep-links a Robinhood Chain pool into ?openPool=", () => {
    expect(openAction(pool({
      chain: "robinhood",
      protocol: "uniswap-v4-rhc",
      poolAddress: "0xnvda",
      pairLabel: "NVDA/NVDAon",
      symbolA: "NVDA",
      symbolB: "NVDAon",
    }))).toEqual({
      kind: "link",
      href: "/app/rwa-pairs?openPool=0xnvda",
    });
  });

  it("disables an Orca pool whose open capability is unsupported", () => {
    const action = openAction(pool({ protocol: "orca-whirlpool", poolAddress: "orca-pool" }));
    expect(action.kind).toBe("disabled");
    if (action.kind === "disabled") expect(action.reason.length).toBeGreaterThan(0);
  });

  it("marks a pool with unsupported token settings as not supported yet", () => {
    const action = openAction(pool({
      protocol: "raydium-clmm",
      poolAddress: "scaled",
      unsupportedIssues: ["ScaledUiAmount multiplier not 1"],
    }));
    expect(action).toEqual({
      kind: "unsupported",
      reason: "This token uses a balance multiplier, which we don't support yet.",
    });
  });
});
