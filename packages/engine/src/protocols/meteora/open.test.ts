import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { meteoraBinArrayAddress } from "./accounts";
import { METEORA_DLMM_PROGRAM_ID } from "./constants";
import {
  type MeteoraAddLiquidityInput, assertMeteoraOpenRange, meteoraAddLiquidityByStrategy2Instruction, meteoraClosePosition2Instruction, meteoraEventAuthority,
  meteoraInitializePositionInstruction, meteoraMaxActiveBinSlippage, meteoraSpotSplit, meteoraSpotXShare,
} from "./open";

// Vectors from the SDK's Anchor coder: `new BorshInstructionCoder(require("@meteora-ag/dlmm").IDL).encode(...)`
// (@meteora-ag/dlmm 1.9.14, @coral-xyz/anchor 0.30), SpotImBalanced = what DLMM.addLiquidityByStrategy sends for Spot.
const SDK = {
  initializePosition: "dbc0ea47bebf6650ddffffff46000000", // lower_bin_id -35, width 70
  addBalanced: "03dd95da6f8d76d515cd5b0700000000b168de3a00000000f4ffffff32000000d8ffffff1d00000006" + "00".repeat(64) + "00000000",
  addOneSide: "03dd95da6f8d76d505000000000000000000000000000000070000000300000008000000140000000600" + "00".repeat(63) + "00000000",
  closePosition2: "ae5a2373ba2893e2",
};
const POOL = new PublicKey("53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H");
const key = () => Keypair.generate().publicKey;

describe("Meteora DLMM open instructions (SDK byte parity)", () => {
  it("event authority PDA matches the program's", () => {
    expect(meteoraEventAuthority().toBase58()).toBe("D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6");
  });

  it("initialize_position", () => {
    const [payer, position] = [key(), key()];
    const ix = meteoraInitializePositionInstruction({ payer, position, lbPair: POOL, owner: payer, lowerBinId: -35, width: 70 });
    expect(ix.data.toString("hex")).toBe(SDK.initializePosition);
    expect(ix.programId.toBase58()).toBe(METEORA_DLMM_PROGRAM_ID);
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [payer.toBase58(), true, true], [position.toBase58(), true, true], [POOL.toBase58(), false, false], [payer.toBase58(), true, false],
      [SystemProgram.programId.toBase58(), false, false], ["SysvarRent111111111111111111111111111111111", false, false],
      ["D1ZN9Wj1fRSUQfCjhvnu1hqDMT7hzjzBBpi12nVniYD6", false, false], [METEORA_DLMM_PROGRAM_ID, false, false],
    ]);
    expect(() => meteoraInitializePositionInstruction({ payer, position, lbPair: POOL, owner: payer, lowerBinId: 0, width: 71 })).toThrow(/width/);
  });

  it("add_liquidity_by_strategy2 (Spot) data, accounts and bin arrays", () => {
    const k = Object.fromEntries(["position", "sender", "userTokenX", "userTokenY", "reserveX", "reserveY", "tokenXMint", "tokenYMint", "tokenXProgram", "tokenYProgram"].map((name) => [name, key()])) as unknown as Omit<MeteoraAddLiquidityInput, "lbPair" | "amountX" | "amountY" | "activeId" | "maxActiveBinSlippage" | "minBinId" | "maxBinId">;
    const ix = meteoraAddLiquidityByStrategy2Instruction({
      ...k, lbPair: POOL, amountX: 123_456_789n, amountY: 987_654_321n, activeId: -12, maxActiveBinSlippage: 50, minBinId: -40, maxBinId: 29,
    });
    expect(ix.data.toString("hex")).toBe(SDK.addBalanced);
    expect(ix.keys).toHaveLength(14 + 2); // bin arrays -1 and 0
    expect(ix.keys[2]).toEqual({ pubkey: new PublicKey(METEORA_DLMM_PROGRAM_ID), isSigner: false, isWritable: false });
    expect(ix.keys[9]).toEqual({ pubkey: k.sender, isSigner: true, isWritable: false });
    expect(ix.keys.slice(14).map((m) => [m.pubkey.toBase58(), m.isWritable])).toEqual([
      [meteoraBinArrayAddress(POOL.toBase58(), -1), true], [meteoraBinArrayAddress(POOL.toBase58(), 0), true],
    ]);
    const oneSide = meteoraAddLiquidityByStrategy2Instruction({
      ...k, lbPair: POOL, amountX: 5n, amountY: 0n, activeId: 7, maxActiveBinSlippage: 3, minBinId: 8, maxBinId: 20,
    });
    expect(oneSide.data.toString("hex")).toBe(SDK.addOneSide);
  });

  it("close_position2 refunds rent to the given receiver", () => {
    const [position, sender] = [key(), key()];
    const ix = meteoraClosePosition2Instruction({ position, sender, rentReceiver: sender });
    expect(ix.data.toString("hex")).toBe(SDK.closePosition2);
    expect(ix.keys.map((m) => [m.isSigner, m.isWritable])).toEqual([[false, true], [true, false], [false, true], [false, false], [false, false]]);
    expect(ix.keys[2]!.pubkey.equals(sender)).toBe(true);
  });

  it("rejects ranges v1 cannot open", () => {
    expect(assertMeteoraOpenRange(-35, 34)).toBe(70);
    expect(() => assertMeteoraOpenRange(0, 70)).toThrow(/at most 70/);
    expect(() => assertMeteoraOpenRange(5, 4)).toThrow(/Invalid/);
    expect(() => assertMeteoraOpenRange(512 * 70, 512 * 70 + 1)).toThrow(/bitmap extension/);
  });

  it("Spot split and active-bin slippage", () => {
    expect(meteoraMaxActiveBinSlippage(50, 1)).toBe(50);
    expect(meteoraMaxActiveBinSlippage(50, 80)).toBe(1);
    expect(meteoraSpotXShare(0, -10, 10)).toEqual({ numerator: 21n, denominator: 42n });
    expect(meteoraSpotSplit(1_000n, 0, -10, 10)).toEqual({ x: 500n, y: 500n });
    expect(meteoraSpotSplit(1_000n, 0, 1, 10)).toEqual({ x: 1_000n, y: 0n });
    expect(meteoraSpotSplit(1_000n, 0, -10, -1)).toEqual({ x: 0n, y: 1_000n });
    expect(meteoraSpotSplit(1_000n, 5, 0, 9)).toEqual({ x: 450n, y: 550n });
  });
});
