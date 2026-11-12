import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/orca-positions-cbbtc-wbtc.json";
import golden from "../../fixtures/orca-whirlpools-core-parity.json";
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

const expectedSqrtPrice = new Map<number, bigint>(
  (golden.tickIndexToSqrtPrice as [number, string][]).map(([tick, sqrt]) => [tick, BigInt(sqrt)]),
);
const expectedPosition = new Map(golden.positions.map((row) => [row.address, row]));
const expectedEdge = new Map(golden.rangeEdgeAmounts.map((row) => [row.sqrtPrice, row]));

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

/**
 * Golden values recorded once from @orca-so/whirlpools-core@3.1.1 on main
 * c04bbd7d61d4c961f86fc01bf9b69f15d8fb765d (2026-11-12, Asia/Taipei). Assertions stay
 * exact (`toBe` / `toEqual`); none were loosened to toBeCloseTo or a wider epsilon.
 */
describe("parity with recorded @orca-so/whirlpools-core@3.1.1 fixtures", () => {
  it("tickIndexToSqrtPrice matches across the full tick range", () => {
    const ticks = [ORCA_MIN_TICK, ORCA_MAX_TICK, 0, 1, -1];
    for (let tick = ORCA_MIN_TICK; tick <= ORCA_MAX_TICK; tick += 997) ticks.push(tick);
    for (let tick = -1500; tick <= 1500; tick++) ticks.push(tick);
    for (let bit = 0; bit < 19; bit++) ticks.push(1 << bit, -(1 << bit), (1 << bit) - 1, -((1 << bit) - 1));
    const used = ticks.filter((t) => t >= ORCA_MIN_TICK && t <= ORCA_MAX_TICK);
    expect(new Set(used).size).toBe(golden.tickIndexToSqrtPrice.length);
    for (const tick of used) {
      expect(orcaTickIndexToSqrtPrice(tick), String(tick)).toBe(expectedSqrtPrice.get(tick));
    }
    expect(() => orcaTickIndexToSqrtPrice(ORCA_MAX_TICK + 1)).toThrow("out of range");
  });

  it.each(fixture.positions.map((address, i) => [i, address] as const))("position %i: fees, amounts and range status", (_i, address) => {
    const { position, lower, upper } = snapshot(address);
    expect(lower.initialized && upper.initialized).toBe(true);
    const ours = orcaUncollectedFees({ tickCurrentIndex: pool.tickCurrentIndex, feeGrowth: growth, position, lower, upper });
    const recorded = expectedPosition.get(address);
    expect(recorded, address).toBeDefined();
    expect(ours).toEqual({ feeA: BigInt(recorded!.feeOwedA), feeB: BigInt(recorded!.feeOwedB) });
    expect(ours.feeA).toBeGreaterThanOrEqual(position.feeOwedA);

    const amounts = orcaAmountsForLiquidity(position.liquidity, pool.sqrtPriceX64, position.tickLowerIndex, position.tickUpperIndex);
    expect(amounts).toEqual({ amountA: BigInt(recorded!.tokenEstA), amountB: BigInt(recorded!.tokenEstB) });

    expect(orcaRangeSide(pool.sqrtPriceX64, position.tickLowerIndex, position.tickUpperIndex))
      .toBe({ priceBelowRange: "below", priceInRange: "inside", priceAboveRange: "above" }[recorded!.status]);
  });

  it("amount and status boundaries match at the range edges", () => {
    for (const sqrt of [orcaTickIndexToSqrtPrice(9), orcaTickIndexToSqrtPrice(29), orcaTickIndexToSqrtPrice(9) + 1n, orcaTickIndexToSqrtPrice(29) - 1n]) {
      const recorded = expectedEdge.get(sqrt.toString());
      expect(recorded, sqrt.toString()).toBeDefined();
      expect(orcaAmountsForLiquidity(123456789012345n, sqrt, 9, 29)).toEqual({ amountA: BigInt(recorded!.tokenEstA), amountB: BigInt(recorded!.tokenEstB) });
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
