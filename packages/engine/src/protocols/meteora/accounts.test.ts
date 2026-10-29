import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/meteora-dlmm-accounts-cbbtc-wbtc.json";
import {
  BIN_ARRAY_ACCOUNT_LEN, decodeLbPair, decodeMeteoraBinArray, decodeMintDecimals, meteoraBaseFeeRate, meteoraBinArrayAddress,
  meteoraBinArrayIndex, meteoraBinArrayIndexesForRange, meteoraBinPrice, meteoraTotalFeeRate, meteoraVariableFeeRate,
  mintHasFreezeAuthority,
} from "./accounts";
import { CBBTC_MINT, WBTC_WORMHOLE_MINT } from "./constants";

const POOL = "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H";
const accounts = fixture.accounts as Record<string, { owner: string; data: string } | null>;
const bytes = (key: string) => Buffer.from(accounts[key]!.data, "base64");
const ARRAY_INDEXES = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4];

describe("decodeLbPair (captured mainnet cbBTC/WBTC)", () => {
  const pool = decodeLbPair(bytes(POOL));

  it("decodes the static/variable parameters, mints and reserves", () => {
    expect(pool).toMatchObject({
      binStep: 1, activeId: 16, status: 0, pairType: 0, baseFactor: 10_000, baseFeePowerFactor: 0,
      variableFeeControl: 2_000_000, maxVolatilityAccumulator: 100_000, volatilityAccumulator: 0,
      minBinId: -436_704, maxBinId: 436_704, protocolShare: 1000,
      tokenXMint: CBBTC_MINT, tokenYMint: WBTC_WORMHOLE_MINT,
      reserveX: "5LaTKNpjhHoxmWrCFPqhSkUHKdzpK3b95PdDwQecCxmH", reserveY: "Hrz5yLrAKJtC5FttkWEupPwsYSVteEJiKoNrwvjnvxRs",
      bitmapBinArrays: [-1, 0, 1, 3], tokenProgramFlagX: 0, tokenProgramFlagY: 0,
    });
  });

  it("derives the fee rates (parts per 1e9)", () => {
    expect(meteoraBaseFeeRate(pool)).toBe(100_000); // 0.01%
    expect(meteoraVariableFeeRate(pool)).toBe(0);
    expect(meteoraVariableFeeRate({ ...pool, volatilityAccumulator: 10_000 })).toBe(2_000); // ceil(2e6 × 1e8 / 1e11)
    expect(meteoraTotalFeeRate({ ...pool, volatilityAccumulator: 10_000 })).toBe(102_000);
    expect(meteoraTotalFeeRate({ ...pool, variableFeeControl: 4_000_000_000, volatilityAccumulator: 100_000 })).toBe(100_000_000);
  });

  it("rejects other accounts and truncated data", () => {
    expect(() => decodeLbPair(bytes(POOL).subarray(0, 903))).toThrow(/LbPair/);
    const other = Buffer.from(bytes(POOL)); other[0] = 0;
    expect(() => decodeLbPair(other)).toThrow(/LbPair/);
    expect(() => decodeLbPair(bytes(meteoraBinArrayAddress(POOL, 0)))).toThrow(/LbPair/);
  });
});

describe("bin arrays", () => {
  it("derives the captured PDAs; -5/-4 do not exist, -3…4 do", () => {
    const keys = ARRAY_INDEXES.map((index) => meteoraBinArrayAddress(POOL, index));
    expect(keys.every((key) => key in accounts)).toBe(true);
    expect(keys.map((key) => accounts[key] !== null)).toEqual([false, false, true, true, true, true, true, true, true, true]);
  });

  it("decodes every existing array with its index, pool and 70 bins", () => {
    for (const index of ARRAY_INDEXES.slice(2)) {
      const array = decodeMeteoraBinArray(bytes(meteoraBinArrayAddress(POOL, index)));
      expect(array).toMatchObject({ index, lbPair: POOL });
      expect(array.bins).toHaveLength(70);
      expect(array.bins[0]!.binId).toBe(index * 70);
    }
  });

  it("matches the on-chain Q64.64 bin price and the datapi reserves", () => {
    const array = decodeMeteoraBinArray(bytes(meteoraBinArrayAddress(POOL, 0)));
    const active = array.bins[16]!;
    expect(active).toMatchObject({ binId: 16, amountX: 350n, amountY: 6_535_090n });
    expect(Number(active.priceX64) / 2 ** 64).toBeCloseTo(meteoraBinPrice(16, 1), 12);
    let x = 0n, y = 0n;
    for (const index of ARRAY_INDEXES.slice(2)) {
      for (const bin of decodeMeteoraBinArray(bytes(meteoraBinArrayAddress(POOL, index))).bins) { x += bin.amountX; y += bin.amountY; }
    }
    // datapi token_x_amount 2.18049319 / token_y_amount 1.95571161 include unclaimed fees; bins hold the liquidity.
    expect(x).toBe(216_691_663n);
    expect(y).toBe(194_193_145n);
  });

  it("rejects other accounts and truncated arrays", () => {
    const data = bytes(meteoraBinArrayAddress(POOL, 0));
    expect(data.length).toBe(BIN_ARRAY_ACCOUNT_LEN);
    expect(() => decodeMeteoraBinArray(data.subarray(0, BIN_ARRAY_ACCOUNT_LEN - 1))).toThrow(/truncated/);
    expect(() => decodeMeteoraBinArray(bytes(POOL))).toThrow(/bin array/);
  });

  it("indexes bins with floor division", () => {
    expect([-71, -70, -1, 0, 69, 70].map(meteoraBinArrayIndex)).toEqual([-2, -1, -1, 0, 0, 1]);
    expect(meteoraBinArrayIndexesForRange(-284, 316)).toEqual(ARRAY_INDEXES);
    expect(meteoraBinArrayIndexesForRange(5, 20)).toEqual([0]);
  });
});

describe("mints", () => {
  it("reads decimals and freeze authority (cbBTC still has one, WBTC does not)", () => {
    expect(decodeMintDecimals(bytes(CBBTC_MINT))).toBe(8);
    expect(decodeMintDecimals(bytes(WBTC_WORMHOLE_MINT))).toBe(8);
    expect(mintHasFreezeAuthority(bytes(CBBTC_MINT))).toBe(true);
    expect(mintHasFreezeAuthority(bytes(WBTC_WORMHOLE_MINT))).toBe(false);
    expect(() => decodeMintDecimals(new Uint8Array(10))).toThrow();
  });
});
