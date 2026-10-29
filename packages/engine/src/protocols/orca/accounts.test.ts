import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/orca-whirlpool-accounts-cbbtc-wbtc.json";
import { CBBTC_MINT, ORCA_WHIRLPOOL_PROGRAM_ID, ORCA_WHIRLPOOLS_CONFIG, WBTC_WORMHOLE_MINT } from "./constants";
import {
  DYNAMIC_TICK_ARRAY_DISCRIMINATOR, FIXED_TICK_ARRAY_DISCRIMINATOR, FIXED_TICK_ARRAY_LEN, ORCA_TICK_ARRAY_SIZE,
  WHIRLPOOL_DISCRIMINATOR, decodeMintDecimals, decodeOrcaTickArray, decodeWhirlpool, orcaTickArrayAddress,
  orcaTickArrayStartIndex, orcaTickArrayStartsForWindow,
} from "./accounts";

const POOL = "4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72";
const accounts = fixture.accounts as Record<string, { owner: string; data: string } | null>;
const bytes = (address: string) => Buffer.from(accounts[address]!.data, "base64");
const STARTS = [-352, -264, -176, -88, 0, 88, 176, 264];

describe("Orca account discriminators", () => {
  it.each([
    ["Whirlpool", WHIRLPOOL_DISCRIMINATOR],
    ["TickArray", FIXED_TICK_ARRAY_DISCRIMINATOR],
    ["DynamicTickArray", DYNAMIC_TICK_ARRAY_DISCRIMINATOR],
  ])("%s = sha256(account:%s)[0..8]", (name, expected) => {
    expect(createHash("sha256").update(`account:${name}`).digest("hex").slice(0, 16)).toBe(expected);
  });
});

describe("decodeWhirlpool (mainnet cbBTC/WBTC, golden)", () => {
  it("decodes the captured account", () => {
    expect(accounts[POOL]!.owner).toBe(ORCA_WHIRLPOOL_PROGRAM_ID);
    const state = decodeWhirlpool(bytes(POOL));
    expect(state).toMatchObject({
      whirlpoolsConfig: ORCA_WHIRLPOOLS_CONFIG, tickSpacing: 1, feeRate: 100, protocolFeeRate: 1300,
      tokenMintA: CBBTC_MINT, tokenVaultA: "Br2L7L6Vfro799PuNH7xdQPs6bZ4DGi2DMFsUX3DdUPW",
      tokenMintB: WBTC_WORMHOLE_MINT, tokenVaultB: "4WBthDFFdS8mqJ3o9hoxtaEewcn7nuXpqUnQiHhJfHVQ",
      tickCurrentIndex: 16,
    });
    expect(state.liquidity).toBe(4829409901481n);
    expect(state.sqrtPriceX64).toBe(18461595609128926554n);
  });

  it("rejects other accounts", () => {
    expect(() => decodeWhirlpool(bytes(CBBTC_MINT))).toThrow(/Not an Orca Whirlpool/);
    const wrong = Buffer.from(bytes(POOL)); wrong[0]! ^= 1;
    expect(() => decodeWhirlpool(wrong)).toThrow(/Not an Orca Whirlpool/);
  });
});

describe("tick array addressing", () => {
  it("start index is a multiple of 88 × tickSpacing (floored)", () => {
    expect(ORCA_TICK_ARRAY_SIZE).toBe(88);
    expect(orcaTickArrayStartIndex(16, 1)).toBe(0);
    expect(orcaTickArrayStartIndex(-1, 1)).toBe(-88);
    expect(orcaTickArrayStartIndex(-88, 1)).toBe(-88);
    expect(orcaTickArrayStartIndex(5000, 64)).toBe(0);
    expect(orcaTickArrayStartIndex(-5000, 64)).toBe(-5632);
    expect(orcaTickArrayStartsForWindow(-284, 317, 1)).toEqual(STARTS);
  });

  it("derives the PDAs of the captured mainnet tick arrays", () => {
    const keys = Object.keys(accounts).slice(3);
    expect(STARTS.map((start) => orcaTickArrayAddress(POOL, start))).toEqual(keys);
  });
});

describe("decodeOrcaTickArray", () => {
  it("decodes every captured fixed tick array for the pool", () => {
    const keys = Object.keys(accounts).slice(3);
    const arrays = keys.map((address) => decodeOrcaTickArray(bytes(address), 1));
    arrays.forEach((array, index) => {
      expect(array.kind).toBe("fixed");
      expect(array.whirlpool).toBe(POOL);
      expect(array.startTickIndex).toBe(STARTS[index]);
      for (const tick of array.ticks) {
        expect(tick.tick).toBeGreaterThanOrEqual(STARTS[index]!);
        expect(tick.tick).toBeLessThan(STARTS[index]! + 88);
        expect(tick.liquidityGross).toBeGreaterThan(0n);
      }
    });
    const ticks = arrays.flatMap((array) => array.ticks);
    expect(ticks.length).toBeGreaterThan(10);
    // Active liquidity at tick 16 = sum of liquidityNet of every initialised tick <= 16. The window
    // misses only a few wide positions whose lower tick is below -352 (same-slot capture).
    const below = ticks.filter((tick) => tick.tick <= 16).reduce((sum, tick) => sum + tick.liquidityNet, 0n);
    const active = decodeWhirlpool(bytes(POOL)).liquidity;
    expect(below).toBeLessThanOrEqual(active);
    expect(Number(below) / Number(active)).toBeGreaterThan(0.999);
    expect(ticks.map((tick) => [tick.tick, tick.liquidityNet.toString()])).toMatchSnapshot();
  });

  it("decodes a dynamic tick array identically to the fixed layout", () => {
    const fixedBytes = bytes(Object.keys(accounts)[3 + 4]!); // start 0
    const fixed = decodeOrcaTickArray(fixedBytes, 1);
    const parts: Buffer[] = [];
    const header = Buffer.alloc(60);
    Buffer.from(DYNAMIC_TICK_ARRAY_DISCRIMINATOR, "hex").copy(header, 0);
    header.writeInt32LE(fixed.startTickIndex, 8);
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
    const dynamic = decodeOrcaTickArray(Buffer.concat([header, ...parts]), 1);
    expect(dynamic.kind).toBe("dynamic");
    expect({ ...dynamic, kind: "fixed" }).toEqual(fixed);
  });

  it("rejects truncated, mislabelled or foreign accounts", () => {
    const fixedBytes = bytes(Object.keys(accounts)[3]!);
    expect(fixedBytes.length).toBe(FIXED_TICK_ARRAY_LEN);
    expect(() => decodeOrcaTickArray(fixedBytes.subarray(0, 100), 1)).toThrow(/truncated/);
    expect(() => decodeOrcaTickArray(bytes(POOL), 1)).toThrow(/Not an Orca tick array/);
    const dyn = Buffer.alloc(60 + 88);
    Buffer.from(DYNAMIC_TICK_ARRAY_DISCRIMINATOR, "hex").copy(dyn, 0);
    dyn[60] = 1; // tagged initialised but bitmap says no
    expect(() => decodeOrcaTickArray(dyn, 1)).toThrow(/bitmap mismatch|truncated/);
  });
});

describe("decodeMintDecimals", () => {
  it("reads 8 decimals for cbBTC and WBTC", () => {
    expect(decodeMintDecimals(bytes(CBBTC_MINT))).toBe(8);
    expect(decodeMintDecimals(bytes(WBTC_WORMHOLE_MINT))).toBe(8);
  });
});
