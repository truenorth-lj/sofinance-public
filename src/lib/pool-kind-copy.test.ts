import { describe, expect, it } from "vitest";
import { CBBTC_MINT, HSOL_MINT, NATIVE_SOL_MINT, USDC_MINT, USDT_MINT, WBTC_PORTAL_MINT } from "@/lib/rwa-allowlist";
import {
  CENTER_ON_CURRENT_PRICE_LABEL,
  CENTER_ON_FAIR_LABEL,
  CENTER_ON_STAKE_RATE_LABEL,
  SAME_ASSET_PRICE_MOVE_NOTE,
  STOCK_PRICE_MOVE_NOTE,
  centerRangeLabel,
  isNeutralAssetCopyPool,
  shareCalcPriceMoveNote,
} from "./pool-kind-copy";

const BANNED = /backtest|\bearn\b|\byield\b|\bAPY\b|guaranteed|open source/i;

describe("pool-kind display copy", () => {
  const btc = { mintA: CBBTC_MINT, mintB: WBTC_PORTAL_MINT };
  const btcFlipped = { mintA: WBTC_PORTAL_MINT, mintB: CBBTC_MINT };
  const lst = { mintA: NATIVE_SOL_MINT, mintB: HSOL_MINT };
  const lstFlipped = { mintA: HSOL_MINT, mintB: NATIVE_SOL_MINT };
  const stock = { mintA: "tsla-mint", mintB: "tslax-mint" };
  const stable = { mintA: USDC_MINT, mintB: USDT_MINT };
  const nativeWbtc = { mintA: CBBTC_MINT, mintB: "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ" };

  it("uses official-stake-rate wording for SOL/hSOL in either mint order", () => {
    for (const pool of [lst, lstFlipped]) {
      expect(isNeutralAssetCopyPool(pool)).toBe(true);
      expect(centerRangeLabel(pool)).toBe(CENTER_ON_STAKE_RATE_LABEL);
      expect(shareCalcPriceMoveNote(pool)).toBe(SAME_ASSET_PRICE_MOVE_NOTE);
    }
    expect(CENTER_ON_STAKE_RATE_LABEL).toBe("Center range on the official stake rate");
  });

  it("uses current-pool-price wording for cbBTC/WBTC in either mint order", () => {
    for (const pool of [btc, btcFlipped]) {
      expect(isNeutralAssetCopyPool(pool)).toBe(true);
      expect(centerRangeLabel(pool)).toBe(CENTER_ON_CURRENT_PRICE_LABEL);
      expect(shareCalcPriceMoveNote(pool)).toBe(SAME_ASSET_PRICE_MOVE_NOTE);
    }
    expect(CENTER_ON_CURRENT_PRICE_LABEL).toBe("Center range on the current pool price");
    expect(SAME_ASSET_PRICE_MOVE_NOTE).toBe("Both tokens track the same asset, and that move is left out.");
  });

  it("keeps the existing stock wording for same-stock pools, stables, unknown mints, and a look-alike BTC mint", () => {
    for (const pool of [stock, stable, nativeWbtc, { mintA: CBBTC_MINT }, {}, { mintA: "", mintB: "" }]) {
      expect(isNeutralAssetCopyPool(pool)).toBe(false);
      expect(centerRangeLabel(pool)).toBe(CENTER_ON_FAIR_LABEL);
      expect(shareCalcPriceMoveNote(pool)).toBe(STOCK_PRICE_MOVE_NOTE);
    }
    expect(CENTER_ON_FAIR_LABEL).toBe("Center range on the fair price");
    expect(STOCK_PRICE_MOVE_NOTE).toBe("The stock's own price moves both sides alike and is left out.");
  });

  it("avoids banned words in all wordings", () => {
    for (const text of [
      CENTER_ON_FAIR_LABEL,
      CENTER_ON_CURRENT_PRICE_LABEL,
      CENTER_ON_STAKE_RATE_LABEL,
      STOCK_PRICE_MOVE_NOTE,
      SAME_ASSET_PRICE_MOVE_NOTE,
    ]) {
      expect(text).not.toMatch(BANNED);
    }
  });
});
