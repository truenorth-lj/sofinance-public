import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  HSOL_MINT,
  HSOL_STAKE_POOL_PROGRAM,
  HSOL_RATE_CACHE_TTL_MS,
  STAKE_POOL_MINT_OFFSET,
  STAKE_POOL_TOKEN_PROGRAM_OFFSET,
  STAKE_POOL_TOTAL_LAMPORTS_OFFSET,
  STAKE_POOL_TOKEN_SUPPLY_OFFSET,
  STAKE_POOL_MIN_LEN,
  clearHsolRateCache,
  isSolHsolMintPair,
  lstFairPriceBPerA,
  lstUnderlyingPerToken,
  readHsolSolExchangeRate,
  solPerHsolFromStakePoolAccount,
} from "./hsol-rate";
import { NATIVE_SOL_MINT } from "./ids";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

function writePubkey(data: Uint8Array, offset: number, address: string): void {
  data.set(new PublicKey(address).toBytes(), offset);
}

function writeU64(data: Uint8Array, offset: number, value: bigint): void {
  new DataView(data.buffer, offset, 8).setBigUint64(0, value, true);
}

function stakePoolBytes(input: { totalLamports: bigint; poolTokenSupply: bigint; mint?: string }): Uint8Array {
  const data = new Uint8Array(STAKE_POOL_MIN_LEN);
  writePubkey(data, STAKE_POOL_MINT_OFFSET, input.mint ?? HSOL_MINT);
  writePubkey(data, STAKE_POOL_TOKEN_PROGRAM_OFFSET, TOKEN_PROGRAM.toBase58());
  writeU64(data, STAKE_POOL_TOTAL_LAMPORTS_OFFSET, input.totalLamports);
  writeU64(data, STAKE_POOL_TOKEN_SUPPLY_OFFSET, input.poolTokenSupply);
  return data;
}

describe("solPerHsolFromStakePoolAccount", () => {
  it("decodes totalLamports / poolTokenSupply at the SPL StakePool offsets", () => {
    const totalLamports = 578_222_808_382_042n;
    const poolTokenSupply = 482_646_681_450_678n;
    const decoded = solPerHsolFromStakePoolAccount(stakePoolBytes({ totalLamports, poolTokenSupply }), {
      owner: HSOL_STAKE_POOL_PROGRAM,
    });
    expect(decoded).toEqual({
      solPerHsol: Number(totalLamports) / Number(poolTokenSupply),
      totalLamports,
      poolTokenSupply,
    });
    expect(decoded!.solPerHsol).toBeCloseTo(1.1980250369568344, 12);
  });

  it("rejects a short account, the wrong owner, the wrong mint, or a zero supply", () => {
    const good = stakePoolBytes({ totalLamports: 12n * 10n ** 14n, poolTokenSupply: 10n * 10n ** 14n });
    expect(solPerHsolFromStakePoolAccount(good.subarray(0, 200), { owner: HSOL_STAKE_POOL_PROGRAM })).toBeNull();
    expect(solPerHsolFromStakePoolAccount(good, { owner: "11111111111111111111111111111111" })).toBeNull();
    expect(solPerHsolFromStakePoolAccount(
      stakePoolBytes({ totalLamports: 12n * 10n ** 14n, poolTokenSupply: 10n * 10n ** 14n, mint: NATIVE_SOL_MINT }),
      { owner: HSOL_STAKE_POOL_PROGRAM },
    )).toBeNull();
    expect(solPerHsolFromStakePoolAccount(
      stakePoolBytes({ totalLamports: 12n * 10n ** 14n, poolTokenSupply: 0n }),
      { owner: HSOL_STAKE_POOL_PROGRAM },
    )).toBeNull();
  });

  it("rejects a rate outside 1–3 SOL per hSOL", () => {
    const owner = { owner: HSOL_STAKE_POOL_PROGRAM };
    expect(solPerHsolFromStakePoolAccount(stakePoolBytes({ totalLamports: 9n * 10n ** 8n, poolTokenSupply: 10n * 10n ** 8n }), owner)).toBeNull();
    expect(solPerHsolFromStakePoolAccount(stakePoolBytes({ totalLamports: 31n * 10n ** 8n, poolTokenSupply: 10n * 10n ** 8n }), owner)).toBeNull();
  });
});

describe("isSolHsolMintPair / lstFairPriceBPerA / lstUnderlyingPerToken", () => {
  const rate = 1.19785;
  it("matches wSOL and hSOL in either order and no other pair", () => {
    expect(isSolHsolMintPair(NATIVE_SOL_MINT, HSOL_MINT)).toBe(true);
    expect(isSolHsolMintPair(HSOL_MINT, NATIVE_SOL_MINT)).toBe(true);
    expect(isSolHsolMintPair(NATIVE_SOL_MINT, NATIVE_SOL_MINT)).toBe(false);
    expect(isSolHsolMintPair(NATIVE_SOL_MINT, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false);
  });

  it("quotes fair B-per-A in the pool's mint order", () => {
    expect(lstFairPriceBPerA(NATIVE_SOL_MINT, HSOL_MINT, rate)).toBeCloseTo(1 / rate, 12);
    expect(lstFairPriceBPerA(HSOL_MINT, NATIVE_SOL_MINT, rate)).toBe(rate);
    expect(lstFairPriceBPerA(NATIVE_SOL_MINT, NATIVE_SOL_MINT, rate)).toBeNull();
    expect(lstFairPriceBPerA(NATIVE_SOL_MINT, HSOL_MINT, 0)).toBeNull();
  });

  it("counts share units in SOL: 1 for wSOL, the official rate for hSOL", () => {
    expect(lstUnderlyingPerToken(NATIVE_SOL_MINT, rate)).toBe(1);
    expect(lstUnderlyingPerToken(HSOL_MINT, rate)).toBe(rate);
    expect(lstUnderlyingPerToken("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rate)).toBeNull();
  });
});

describe("readHsolSolExchangeRate", () => {
  const totalLamports = 12n * 10n ** 14n;
  const poolTokenSupply = 10n * 10n ** 14n;
  const data = Buffer.from(stakePoolBytes({ totalLamports, poolTokenSupply }));

  it("reads through the given connection, caches a success, and does not cache a miss", async () => {
    clearHsolRateCache();
    let calls = 0;
    const connection = {
      getAccountInfo: async () => {
        calls += 1;
        return { data, owner: new PublicKey(HSOL_STAKE_POOL_PROGRAM), lamports: 1, executable: false, rentEpoch: 0 };
      },
    };
    let now = 1_000;
    const first = await readHsolSolExchangeRate({ connection, now: () => now, ttlMs: HSOL_RATE_CACHE_TTL_MS });
    const second = await readHsolSolExchangeRate({ connection, now: () => now, ttlMs: HSOL_RATE_CACHE_TTL_MS });
    expect(first?.solPerHsol).toBe(1.2);
    expect(second?.solPerHsol).toBe(1.2);
    expect(calls).toBe(1);

    now = 1_000 + HSOL_RATE_CACHE_TTL_MS + 1;
    await readHsolSolExchangeRate({ connection, now: () => now, ttlMs: HSOL_RATE_CACHE_TTL_MS });
    expect(calls).toBe(2);

    clearHsolRateCache();
    const missing = { getAccountInfo: async () => (calls += 1, null) };
    expect(await readHsolSolExchangeRate({ connection: missing, now: () => 0 })).toBeNull();
    expect(await readHsolSolExchangeRate({ connection: missing, now: () => 0 })).toBeNull();
    expect(calls).toBe(4);
  });
});
