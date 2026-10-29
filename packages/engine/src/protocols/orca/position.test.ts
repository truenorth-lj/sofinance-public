import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import * as core from "@orca-so/whirlpools-core";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/orca-positions-cbbtc-wbtc.json";
import { DYNAMIC_TICK_ARRAY_DISCRIMINATOR, decodeWhirlpool, orcaTickArrayAddress, orcaTickArrayStartIndex } from "./accounts";
import { ORCA_ALLOWLISTED_POOLS } from "./constants";
import {
  ORCA_MAX_TICK, ORCA_MIN_TICK, ORCA_POSITION_ACCOUNT_LEN, ORCA_POSITION_DISCRIMINATOR, decodeOrcaPosition,
  decodeWhirlpoolFeeGrowth, isOrcaPositionAccount, orcaAmountsForLiquidity, orcaPositionAddress, orcaRangeSide,
  orcaTickIndexToSqrtPrice, orcaUncollectedFees, readOrcaTickFeeGrowth,
} from "./position";

const accounts = fixture.accounts as Record<string, { owner: string; data: string }>;
const bytes = (address: string) => Buffer.from(accounts[address]!.data, "base64");
const POOL = fixture.pool;
const pool = decodeWhirlpool(bytes(POOL));
const growth = decodeWhirlpoolFeeGrowth(bytes(POOL));
const arrayFor = (tick: number) => bytes(fixture.tickArrays[String(orcaTickArrayStartIndex(tick, 1)) as "0"]);

function snapshot(address: string) {
  const position = decodeOrcaPosition(bytes(address));
  const lower = readOrcaTickFeeGrowth(arrayFor(position.tickLowerIndex), 1, position.tickLowerIndex);
  const upper = readOrcaTickFeeGrowth(arrayFor(position.tickUpperIndex), 1, position.tickUpperIndex);
  return { position, lower, upper };
}

describe("Orca position account (mainnet cbBTC/WBTC capture)", () => {
  it("discriminator is sha256(account:Position)[0..8]", () => {
    expect(createHash("sha256").update("account:Position").digest("hex").slice(0, 16)).toBe(ORCA_POSITION_DISCRIMINATOR);
  });

  it("captured fixture is the allowlisted pool with in / above / below positions", () => {
    expect(POOL).toBe(ORCA_ALLOWLISTED_POOLS[0]!.poolAddress);
    expect(pool.tickCurrentIndex).toBe(16);
    expect(fixture.positions.map((address) => orcaRangeSide(pool.sqrtPriceX64, decodeOrcaPosition(bytes(address)).tickLowerIndex, decodeOrcaPosition(bytes(address)).tickUpperIndex)))
      .toEqual(["inside", "above", "below"]);
    for (const [start, address] of Object.entries(fixture.tickArrays)) expect(orcaTickArrayAddress(POOL, Number(start))).toBe(address);
  });

  it("derives each position PDA from its NFT mint and decodes the account", () => {
    fixture.positions.forEach((address, i) => {
      const data = bytes(address);
      expect(data.length).toBe(ORCA_POSITION_ACCOUNT_LEN);
      expect(isOrcaPositionAccount(data)).toBe(true);
      const position = decodeOrcaPosition(data);
      expect(position.whirlpool).toBe(POOL);
      expect(position.positionMint).toBe(fixture.positionMints[i]);
      expect(orcaPositionAddress(position.positionMint)).toBe(address);
    });
    expect(decodeOrcaPosition(bytes(fixture.positions[0]!))).toMatchObject({ tickLowerIndex: 9, tickUpperIndex: 29 });
  });

  it("rejects non-position accounts", () => {
    expect(() => decodeOrcaPosition(bytes(POOL))).toThrow("Not an Orca Whirlpool position account");
    expect(() => decodeOrcaPosition(bytes(fixture.positions[0]!).subarray(0, 200))).toThrow("Not an Orca Whirlpool position account");
    expect(() => decodeWhirlpoolFeeGrowth(bytes(fixture.positions[0]!))).toThrow("Not an Orca Whirlpool account");
  });
});

describe("parity with @orca-so/whirlpools-core", () => {
  it("tickIndexToSqrtPrice matches across the full tick range", () => {
    const ticks = [ORCA_MIN_TICK, ORCA_MAX_TICK, 0, 1, -1];
    for (let tick = ORCA_MIN_TICK; tick <= ORCA_MAX_TICK; tick += 997) ticks.push(tick);
    for (let tick = -1500; tick <= 1500; tick++) ticks.push(tick);
    for (let bit = 0; bit < 19; bit++) ticks.push(1 << bit, -(1 << bit), (1 << bit) - 1, -((1 << bit) - 1));
    for (const tick of ticks.filter((t) => t >= ORCA_MIN_TICK && t <= ORCA_MAX_TICK)) {
      expect(orcaTickIndexToSqrtPrice(tick), String(tick)).toBe(core.tickIndexToSqrtPrice(tick));
    }
    expect(() => orcaTickIndexToSqrtPrice(ORCA_MAX_TICK + 1)).toThrow("out of range");
  });

  it.each(fixture.positions.map((address, i) => [i, address] as const))("position %i: fees, amounts and range status", (_i, address) => {
    const { position, lower, upper } = snapshot(address);
    expect(lower.initialized && upper.initialized).toBe(true);
    const ours = orcaUncollectedFees({ tickCurrentIndex: pool.tickCurrentIndex, feeGrowth: growth, position, lower, upper });
    const reward = { emissionsPerSecondX64: 0n, growthGlobalX64: 0n };
    const tick = (t: typeof lower) => ({ initialized: t.initialized, liquidityNet: 0n, liquidityGross: 0n, feeGrowthOutsideA: t.feeGrowthOutsideA, feeGrowthOutsideB: t.feeGrowthOutsideB, rewardGrowthsOutside: [0n, 0n, 0n] });
    const quote = core.collectFeesQuote(
      { feeTierIndexSeed: new Uint8Array(2), tickSpacing: pool.tickSpacing, feeRate: pool.feeRate, protocolFeeRate: pool.protocolFeeRate, liquidity: pool.liquidity, sqrtPrice: pool.sqrtPriceX64, tickCurrentIndex: pool.tickCurrentIndex, feeGrowthGlobalA: growth.feeGrowthGlobalA, feeGrowthGlobalB: growth.feeGrowthGlobalB, rewardLastUpdatedTimestamp: 0n, rewardInfos: [reward, reward, reward] },
      { ...position, rewardInfos: [0, 1, 2].map(() => ({ growthInsideCheckpoint: 0n, amountOwed: 0n })) },
      tick(lower),
      tick(upper),
    );
    expect(ours).toEqual({ feeA: quote.feeOwedA, feeB: quote.feeOwedB });
    expect(ours.feeA).toBeGreaterThanOrEqual(position.feeOwedA);

    const amounts = orcaAmountsForLiquidity(position.liquidity, pool.sqrtPriceX64, position.tickLowerIndex, position.tickUpperIndex);
    const decrease = core.decreaseLiquidityQuote(position.liquidity, 0, pool.sqrtPriceX64, position.tickLowerIndex, position.tickUpperIndex);
    expect(amounts).toEqual({ amountA: decrease.tokenEstA, amountB: decrease.tokenEstB });

    const status = core.positionStatus(pool.sqrtPriceX64, position.tickLowerIndex, position.tickUpperIndex);
    expect(orcaRangeSide(pool.sqrtPriceX64, position.tickLowerIndex, position.tickUpperIndex))
      .toBe({ priceBelowRange: "below", priceInRange: "inside", priceAboveRange: "above" }[status as string]);
  });

  it("amount and status boundaries match at the range edges", () => {
    for (const sqrt of [orcaTickIndexToSqrtPrice(9), orcaTickIndexToSqrtPrice(29), orcaTickIndexToSqrtPrice(9) + 1n, orcaTickIndexToSqrtPrice(29) - 1n]) {
      const decrease = core.decreaseLiquidityQuote(123456789012345n, 0, sqrt, 9, 29);
      expect(orcaAmountsForLiquidity(123456789012345n, sqrt, 9, 29)).toEqual({ amountA: decrease.tokenEstA, amountB: decrease.tokenEstB });
    }
    expect(orcaAmountsForLiquidity(0n, pool.sqrtPriceX64, 9, 29)).toEqual({ amountA: 0n, amountB: 0n });
  });
});

describe("readOrcaTickFeeGrowth", () => {
  it("reads the same values from a dynamic tick array", () => {
    const fixedBytes = bytes(fixture.tickArrays["0"]);
    const parts: Buffer[] = [];
    const header = Buffer.alloc(60);
    Buffer.from(DYNAMIC_TICK_ARRAY_DISCRIMINATOR, "hex").copy(header, 0);
    header.writeInt32LE(0, 8);
    new PublicKey(POOL).toBuffer().copy(header, 12);
    let bitmap = 0n;
    for (let i = 0; i < 88; i++) {
      const at = 12 + i * 113;
      if (fixedBytes[at] === 1) {
        bitmap |= 1n << BigInt(i);
        parts.push(Buffer.concat([Buffer.from([1]), fixedBytes.subarray(at + 1, at + 113)]));
      } else parts.push(Buffer.from([0]));
    }
    header.writeBigUInt64LE(bitmap & ((1n << 64n) - 1n), 44);
    header.writeBigUInt64LE(bitmap >> 64n, 52);
    const dynamicBytes = Buffer.concat([header, ...parts]);
    let initialized = 0;
    for (let tick = 0; tick < 88; tick++) {
      const fixed = readOrcaTickFeeGrowth(fixedBytes, 1, tick);
      if (fixed.initialized) initialized++;
      expect(readOrcaTickFeeGrowth(dynamicBytes, 1, tick)).toEqual(fixed);
    }
    expect(initialized).toBeGreaterThan(5);
  });

  it("rejects ticks outside the array, off spacing, or foreign accounts", () => {
    expect(() => readOrcaTickFeeGrowth(bytes(fixture.tickArrays["0"]), 1, 88)).toThrow("outside this tick array");
    expect(() => readOrcaTickFeeGrowth(bytes(fixture.tickArrays["0"]), 2, 3)).toThrow("tick spacing");
    expect(() => readOrcaTickFeeGrowth(bytes(POOL), 1, 0)).toThrow("Not an Orca tick array account");
    expect(() => readOrcaTickFeeGrowth(bytes(fixture.tickArrays["0"]).subarray(0, 500), 1, 0)).toThrow("truncated");
  });
});
