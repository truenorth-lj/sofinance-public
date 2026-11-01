import { readFileSync } from "node:fs";
import { AccountInfo, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeLbPair, decodeMintDecimals, METEORA_REWARD_INFOS_OFFSET, METEORA_REWARD_INFO_LEN, meteoraBinArrayAddress, meteoraBinArrayIndex } from "./accounts";
import { METEORA_DLMM_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./constants";
import { meteoraClaimFee2Instruction, meteoraRemoveLiquidityByRange2Instruction } from "./liquidity";
import { meteoraAddLiquidityByStrategy2Instruction, meteoraBitmapExtensionAddress, meteoraRangeNeedsBitmapExtension } from "./open";
import { fetchMeteoraBinArrayRent, fetchMeteoraPositionRent, readMeteoraOpenAccounts } from "./rent";
import { checkMeteoraPoolMint, meteoraPoolTokenPrograms } from "./token";

/**
 * Hermetic replay of `fixtures/meteora-dlmm-rwa-t22.json` (public mainnet state of the RWA pools 8k2c TSLA/TSLAx and
 * 5pw5 SPCX/SPCXx, slot 464,010,023, captured by scripts/capture-meteora-rwa-fixture.ts). No network: the RPC is a
 * fake that answers only from the capture.
 */
type Capture = {
  pools: Record<string, { owner: string; data: string; bitmapExtension: { address: string; exists: boolean }; binArrays: Record<string, { address: string; exists: boolean }> }>;
  mints: Record<string, { owner: string; data: string }>;
  rentExemptMinimum: Record<string, number>;
};
const capture: Capture = JSON.parse(readFileSync(new URL("../../fixtures/meteora-dlmm-rwa-t22.json", import.meta.url), "utf8"));
const TSLA_POOL = "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh";
const SPCX_POOL = "5pw5tNUaZJpUCnYjZ1V3gd7XkLbrb4zA9pir4LFph2mj";
const pair = (pool: string) => decodeLbPair(Buffer.from(capture.pools[pool]!.data, "base64"));
const info = (owner: string, data: Buffer): AccountInfo<Buffer> => ({ owner: new PublicKey(owner), data, lamports: 1, executable: false, rentEpoch: 0 });
const mintInfo = (mint: string) => info(capture.mints[mint]!.owner, Buffer.from(capture.mints[mint]!.data, "base64"));

/** Fake RPC: existing accounts are exactly the captured ones; any other key reads as missing. */
function fakeConnection() {
  const existing = new Set<string>();
  for (const pool of Object.values(capture.pools)) {
    if (pool.bitmapExtension.exists) existing.add(pool.bitmapExtension.address);
    for (const array of Object.values(pool.binArrays)) if (array.exists) existing.add(array.address);
  }
  const known = new Set(Object.values(capture.pools).flatMap((pool) => [pool.bitmapExtension.address, ...Object.values(pool.binArrays).map((a) => a.address)]));
  return {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((key) => {
        const address = key.toBase58();
        if (!known.has(address)) throw new Error(`fixture has no answer for ${address}`);
        return existing.has(address) ? info(METEORA_DLMM_PROGRAM_ID, Buffer.alloc(8)) : null;
      });
    },
    async getMinimumBalanceForRentExemption(size: number) {
      const lamports = capture.rentExemptMinimum[String(size)];
      if (lamports === undefined) throw new Error(`fixture has no rent for ${size} bytes`);
      return lamports;
    },
  };
}

/** Token-2022 TLV editing on a captured mint (base 165 bytes + account type, entries from byte 166). */
function withExtension(data: Buffer, type: number, edit: (value: Buffer) => void, appendLength?: number): Buffer {
  const out = Buffer.from(data);
  for (let offset = 166; offset + 4 <= out.length;) {
    const entryType = out.readUInt16LE(offset);
    const length = out.readUInt16LE(offset + 2);
    if (entryType === type) { edit(out.subarray(offset + 4, offset + 4 + length)); return out; }
    offset += 4 + length;
  }
  if (appendLength === undefined) throw new Error(`extension ${type} not present`);
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type);
  header.writeUInt16LE(appendLength, 2);
  const value = Buffer.alloc(appendLength);
  edit(value);
  return Buffer.concat([out, header, value]);
}
const TRANSFER_HOOK = 14;
const PAUSABLE = 26;
const TRANSFER_FEE = 1;

describe("Meteora RWA pools are Token-2022 on both sides (fixture)", () => {
  it.each([TSLA_POOL, SPCX_POOL])("%s: LbPair flags select Token-2022 and the mints are owned by it", (pool) => {
    const state = pair(pool);
    expect(capture.pools[pool]!.owner).toBe(METEORA_DLMM_PROGRAM_ID);
    expect(state.binStep).toBe(1);
    expect(meteoraPoolTokenPrograms(state)).toEqual({ tokenProgramX: TOKEN_2022_PROGRAM_ID, tokenProgramY: TOKEN_2022_PROGRAM_ID });
    for (const mint of [state.tokenXMint, state.tokenYMint]) expect(capture.mints[mint]!.owner).toBe(TOKEN_2022_PROGRAM_ID);
  });

  it("token program flags: 0 = SPL Token, 1 = Token-2022, anything else is refused", () => {
    expect(meteoraPoolTokenPrograms({ tokenProgramFlagX: 0, tokenProgramFlagY: 1 })).toEqual({ tokenProgramX: SPL_TOKEN_PROGRAM_ID, tokenProgramY: TOKEN_2022_PROGRAM_ID });
    expect(() => meteoraPoolTokenPrograms({ tokenProgramFlagX: 2, tokenProgramFlagY: 0 })).toThrow(/Unknown Meteora token program flag/);
  });

  it("the active bins sit past bin array 511, so every preset needs the bitmap extension (which exists)", () => {
    for (const pool of [TSLA_POOL, SPCX_POOL]) {
      const { activeId } = pair(pool);
      expect(meteoraBinArrayIndex(activeId)).toBeGreaterThan(511);
      expect(meteoraRangeNeedsBitmapExtension(activeId - 2, activeId + 1)).toBe(true);
      expect(capture.pools[pool]!.bitmapExtension).toEqual({ address: meteoraBitmapExtensionAddress(pool).toBase58(), exists: true });
    }
  });
});

describe("Token-2022 guard (DESIGN §7.7: transfer hook program, paused, transfer fee)", () => {
  it("today's xStock and Backpack mints are unrestricted (hook authority set but program None, not paused, no fee)", () => {
    const decimals: Record<string, number> = {};
    for (const [mint, account] of Object.entries(capture.mints)) {
      const checked = checkMeteoraPoolMint(mint, mintInfo(mint), TOKEN_2022_PROGRAM_ID);
      expect(checked.restrictions).toEqual([]);
      decimals[mint] = decodeMintDecimals(Buffer.from(account.data, "base64"));
    }
    expect(Object.values(decimals).sort()).toEqual([6, 6, 8, 8]);
  });

  const mint = "TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S";
  const base = Buffer.from(capture.mints[mint]!.data, "base64");
  const check = (data: Buffer) => checkMeteoraPoolMint(mint, info(TOKEN_2022_PROGRAM_ID, data), TOKEN_2022_PROGRAM_ID).restrictions;

  it("stops when the transfer hook gets a program id", () => {
    expect(check(withExtension(base, TRANSFER_HOOK, (value) => value.fill(7, 32, 64)))).toEqual(["transfer_hook"]);
  });

  it("stops when transfers are paused", () => {
    expect(check(withExtension(base, PAUSABLE, (value) => { value[32] = 1; }))).toEqual(["paused"]);
  });

  it("stops when a transfer fee above 0 bps is configured (older or newer epoch)", () => {
    expect(check(withExtension(base, TRANSFER_FEE, (value) => value.writeUInt16LE(1, 106), 108))).toEqual(["transfer_fee"]);
    expect(check(withExtension(base, TRANSFER_FEE, (value) => value.writeUInt16LE(25, 88), 108))).toEqual(["transfer_fee"]);
    expect(check(withExtension(base, TRANSFER_FEE, () => undefined, 108))).toEqual([]);
  });

  it("reports every restriction in a fixed order", () => {
    const all = withExtension(withExtension(withExtension(base, TRANSFER_HOOK, (v) => v.fill(7, 32, 64)), PAUSABLE, (v) => { v[32] = 1; }), TRANSFER_FEE, (v) => v.writeUInt16LE(5, 106), 108);
    expect(check(all)).toEqual(["transfer_hook", "paused", "transfer_fee"]);
  });

  it("refuses a missing mint or one owned by a different token program than the pool declares", () => {
    expect(() => checkMeteoraPoolMint(mint, null, TOKEN_2022_PROGRAM_ID)).toThrow(/does not exist/);
    expect(() => checkMeteoraPoolMint(mint, mintInfo(mint), SPL_TOKEN_PROGRAM_ID)).toThrow(/program does not match/);
  });
});

describe("open readiness and rent from the capture (no new bin arrays in v1)", () => {
  it("position rent is read live: 70-bin base account = 41,899,840 lamports (0.0419 SOL), refundable on close", async () => {
    const connection = fakeConnection();
    for (const width of [4, 10, 60, 70]) {
      expect(await fetchMeteoraPositionRent(connection, width)).toEqual({ lamports: 41_899_840n, refundableOnClose: true });
    }
    await expect(fetchMeteoraPositionRent(connection, 71)).rejects.toThrow(/at most 70/);
    expect(await fetchMeteoraBinArrayRent(connection)).toBe(52_141_120n);
  });

  it("presets of at most 70 bins around the active bin use bin arrays that already exist", async () => {
    const connection = fakeConnection();
    for (const pool of [TSLA_POOL, SPCX_POOL]) {
      const { activeId } = pair(pool);
      for (const [below, above] of [[2, 1], [5, 4], [30, 29]] as const) {
        const accounts = await readMeteoraOpenAccounts(connection, pool, activeId - below, activeId + above);
        expect(accounts.missingBinArrayIndexes).toEqual([]);
        expect(accounts.needsBitmapExtension).toBe(true);
        expect(accounts.bitmapExtension?.toBase58()).toBe(capture.pools[pool]!.bitmapExtension.address);
      }
    }
  });

  it("a wider range reports the bin arrays it would have to create (the adapter blocks the open)", async () => {
    const { activeId } = pair(TSLA_POOL);
    const accounts = await readMeteoraOpenAccounts(fakeConnection(), TSLA_POOL, activeId - 100, activeId + 99);
    expect(accounts.missingBinArrayIndexes).toEqual([656, 659]);
    expect(capture.pools[TSLA_POOL]!.binArrays["656"]!.address).toBe(meteoraBinArrayAddress(TSLA_POOL, 656));
  });
});

describe("builders on the captured Token-2022 pool", () => {
  const state = pair(TSLA_POOL);
  const { tokenProgramX, tokenProgramY } = meteoraPoolTokenPrograms(state);
  const owner = new PublicKey("EweTgJ6vaQDZyH5nk5uaK5iD7n1qr7BXTaxewcjQNEjb");
  const accounts = {
    lbPair: new PublicKey(TSLA_POOL), position: new PublicKey(Buffer.alloc(32, 2)), sender: owner,
    userTokenX: new PublicKey(Buffer.alloc(32, 7)), userTokenY: new PublicKey(Buffer.alloc(32, 8)),
    reserveX: new PublicKey(state.reserveX), reserveY: new PublicKey(state.reserveY),
    tokenXMint: new PublicKey(state.tokenXMint), tokenYMint: new PublicKey(state.tokenYMint),
    tokenXProgram: new PublicKey(tokenProgramX), tokenYProgram: new PublicKey(tokenProgramY),
  };
  const bitmapExtension = meteoraBitmapExtensionAddress(TSLA_POOL);

  it("deposit, withdraw and claim carry the Token-2022 program, the bitmap extension and only the owner as signer", () => {
    const lower = state.activeId - 30;
    const upper = state.activeId + 29;
    const ixs = [
      meteoraAddLiquidityByStrategy2Instruction({ ...accounts, amountX: 1n, amountY: 1n, activeId: state.activeId, maxActiveBinSlippage: 5, minBinId: lower, maxBinId: upper, bitmapExtension }),
      meteoraRemoveLiquidityByRange2Instruction({ ...accounts, fromBinId: lower, toBinId: upper, bps: 10_000, bitmapExtension }),
      meteoraClaimFee2Instruction({ ...accounts, minBinId: lower, maxBinId: upper }),
    ];
    for (const ix of ixs) {
      expect(ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([owner.toBase58()]);
      expect(ix.keys.filter((k) => k.pubkey.toBase58() === TOKEN_2022_PROGRAM_ID)).toHaveLength(2);
      expect(ix.keys.some((k) => k.pubkey.toBase58() === SPL_TOKEN_PROGRAM_ID)).toBe(false);
    }
    expect(ixs[0]!.keys[2]).toEqual({ pubkey: bitmapExtension, isSigner: false, isWritable: true });
    expect(ixs[1]!.keys[2]).toEqual({ pubkey: bitmapExtension, isSigner: false, isWritable: true });
    // Bin arrays 657 and 658 cover the 60-bin range (both exist in the capture).
    expect(ixs[0]!.keys.slice(14).map((k) => k.pubkey.toBase58())).toEqual([657, 658].map((index) => meteoraBinArrayAddress(TSLA_POOL, index)));
  });

  it("without the bitmap extension a range past bin array 511 is still refused (existing v1 callers unchanged)", () => {
    expect(() => meteoraAddLiquidityByStrategy2Instruction({
      ...accounts, amountX: 1n, amountY: 1n, activeId: state.activeId, maxActiveBinSlippage: 5, minBinId: state.activeId - 2, maxBinId: state.activeId + 1,
    })).toThrow(/bitmap extension/);
  });
});

describe("farming rewards (LbPair.reward_infos)", () => {
  it("neither RWA pool has a farming reward set up in the capture (both slots are the default key)", () => {
    expect(pair(TSLA_POOL).rewardMints).toEqual([]);
    expect(pair(SPCX_POOL).rewardMints).toEqual([]);
  });

  it("reads a reward mint written into either slot (the oracle right after the two slots stays in place)", () => {
    const data = Buffer.from(capture.pools[TSLA_POOL]!.data, "base64");
    const oracle = new PublicKey(data.subarray(552, 584)).toBase58();
    const [oraclePda] = PublicKey.findProgramAddressSync([Buffer.from("oracle"), new PublicKey(TSLA_POOL).toBuffer()], new PublicKey(METEORA_DLMM_PROGRAM_ID));
    expect(oracle).toBe(oraclePda.toBase58()); // layout check: reward_infos end exactly at the oracle
    const reward = new PublicKey(TOKEN_2022_PROGRAM_ID);
    reward.toBuffer().copy(data, METEORA_REWARD_INFOS_OFFSET + METEORA_REWARD_INFO_LEN);
    expect(decodeLbPair(data).rewardMints).toEqual([reward.toBase58()]);
  });
});
