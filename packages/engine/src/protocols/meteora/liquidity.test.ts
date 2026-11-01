import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { meteoraBinArrayAddress } from "./accounts";
import { METEORA_DLMM_PROGRAM_ID } from "./constants";
import { meteoraClaimFee2Instruction, meteoraRemoveLiquidityByRange2Instruction, METEORA_MEMO_PROGRAM_ID } from "./liquidity";
import { meteoraAddLiquidityByStrategy2Instruction, meteoraBitmapExtensionAddress } from "./open";

// Vectors from the SDK's Anchor coder and `program.methods.*.accountsPartial(...).instruction()`
// (@meteora-ag/dlmm 1.9.14 IDL, @coral-xyz/anchor 0.30.1, generated offline, no RPC).
const SDK = {
  claimFee2: "70bf65ab1c907fbbddffffff2200000000000000", // min -35, max 34, slices []
  remove10000: "cc02c391359191cdddffffff22000000102700000000", // -35..34, 10,000 bps
  remove5000: "cc02c391359191cdcfb300000ab40000881300000000", // 46031..46090, 5,000 bps
  addWithBitmap: "03dd95da6f8d76d501000000000000000200000000000000edb3000005000000cfb300000ab4000006" + "00".repeat(64) + "00000000",
};
const POOL = new PublicKey("8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh");
const k = (seed: number) => new PublicKey(Buffer.alloc(32, seed));
// Same placeholder keys the SDK vectors used: sender 1, position 2, reserves 3/4, mints 5/6, user ATAs 7/8, programs 9/10.
const accounts = {
  lbPair: POOL, sender: k(1), position: k(2), reserveX: k(3), reserveY: k(4), tokenXMint: k(5), tokenYMint: k(6),
  userTokenX: k(7), userTokenY: k(8), tokenXProgram: k(9), tokenYProgram: k(10),
};
const rows = (keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) => keys.map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable]);
const TAIL = [[METEORA_MEMO_PROGRAM_ID, false, false], ["D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6", false, false], [METEORA_DLMM_PROGRAM_ID, false, false]];
const binArrays = (...indexes: number[]) => indexes.map((index) => [meteoraBinArrayAddress(POOL.toBase58(), index), false, true]);

describe("Meteora DLMM withdraw / claim instructions (SDK byte + account parity)", () => {
  it("claim_fee2", () => {
    const ix = meteoraClaimFee2Instruction({ ...accounts, minBinId: -35, maxBinId: 34 });
    expect(ix.data.toString("hex")).toBe(SDK.claimFee2);
    expect(rows(ix.keys)).toEqual([
      [POOL.toBase58(), false, true], [k(2).toBase58(), false, true], [k(1).toBase58(), true, false],
      [k(3).toBase58(), false, true], [k(4).toBase58(), false, true], [k(7).toBase58(), false, true], [k(8).toBase58(), false, true],
      [k(5).toBase58(), false, false], [k(6).toBase58(), false, false], [k(9).toBase58(), false, false], [k(10).toBase58(), false, false],
      ...TAIL, ...binArrays(-1, 0),
    ]);
  });

  it("remove_liquidity_by_range2 with the bitmap extension", () => {
    const bitmapExtension = meteoraBitmapExtensionAddress(POOL.toBase58());
    expect(bitmapExtension.toBase58()).toBe("31prk6XU62TyUnAVQKUQ8bLn86ReiobZc7AXnn3RDLZd");
    const ix = meteoraRemoveLiquidityByRange2Instruction({ ...accounts, fromBinId: -35, toBinId: 34, bps: 10_000, bitmapExtension });
    expect(ix.data.toString("hex")).toBe(SDK.remove10000);
    expect(rows(ix.keys)).toEqual([
      [k(2).toBase58(), false, true], [POOL.toBase58(), false, true], [bitmapExtension.toBase58(), false, true],
      [k(7).toBase58(), false, true], [k(8).toBase58(), false, true], [k(3).toBase58(), false, true], [k(4).toBase58(), false, true],
      [k(5).toBase58(), false, false], [k(6).toBase58(), false, false], [k(1).toBase58(), true, false],
      [k(9).toBase58(), false, false], [k(10).toBase58(), false, false],
      ...TAIL, ...binArrays(-1, 0),
    ]);
  });

  it("remove_liquidity_by_range2 partial share; absent bitmap extension is the program-id placeholder", () => {
    const ix = meteoraRemoveLiquidityByRange2Instruction({ ...accounts, fromBinId: 46031, toBinId: 46090, bps: 5_000 });
    expect(ix.data.toString("hex")).toBe(SDK.remove5000);
    expect(rows([ix.keys[2]!])).toEqual([[METEORA_DLMM_PROGRAM_ID, false, false]]);
    expect(ix.keys.slice(15).map((m) => m.pubkey.toBase58())).toEqual([657, 658].map((index) => meteoraBinArrayAddress(POOL.toBase58(), index)));
  });

  it("rejects invalid shares and ranges", () => {
    for (const bps of [0, 10_001, 1.5, -1]) {
      expect(() => meteoraRemoveLiquidityByRange2Instruction({ ...accounts, fromBinId: 0, toBinId: 1, bps })).toThrow(/bps/);
    }
    expect(() => meteoraRemoveLiquidityByRange2Instruction({ ...accounts, fromBinId: 2, toBinId: 1, bps: 1 })).toThrow(/Invalid Meteora bin range/);
    expect(() => meteoraClaimFee2Instruction({ ...accounts, minBinId: 2, maxBinId: 1 })).toThrow(/Invalid Meteora bin range/);
  });

  it("add_liquidity_by_strategy2 with the bitmap extension matches the SDK", () => {
    const bitmapExtension = meteoraBitmapExtensionAddress(POOL.toBase58());
    const ix = meteoraAddLiquidityByStrategy2Instruction({
      ...accounts, amountX: 1n, amountY: 2n, activeId: 46061, maxActiveBinSlippage: 5, minBinId: 46031, maxBinId: 46090, bitmapExtension,
    });
    expect(ix.data.toString("hex")).toBe(SDK.addWithBitmap);
    expect(rows(ix.keys.slice(0, 3))).toEqual([[k(2).toBase58(), false, true], [POOL.toBase58(), false, true], [bitmapExtension.toBase58(), false, true]]);
  });
});
