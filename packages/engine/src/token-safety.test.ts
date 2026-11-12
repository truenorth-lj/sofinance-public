import { AccountState, DefaultAccountStateLayout, ExtensionType, PausableConfigLayout, TransferFeeConfigLayout, type Mint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { mintBlockReasons, mintDefaultFrozen, mintHasTransferFee, mintIsPaused, poolMintIssues, SCALED_UI_MULTIPLIER_TOLERANCE, scaledUiAmountOutOfTolerance } from "./token-safety";

const key = new PublicKey("So11111111111111111111111111111111111111112");
function tlv(entries: [ExtensionType, Buffer][]): Buffer {
  return Buffer.concat(entries.map(([type, data]) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(data.length, 2);
    return Buffer.concat([head, data]);
  }));
}
function encode<T>(layout: { span: number; encode(value: T, b: Buffer): number }, value: T): Buffer {
  const out = Buffer.alloc(layout.span);
  layout.encode(value, out);
  return out;
}
const fee = (bps: number) => ({ epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: bps });
const transferFee = (older: number, newer: number) => encode(TransferFeeConfigLayout, {
  transferFeeConfigAuthority: key, withdrawWithheldAuthority: key, withheldAmount: 0n,
  olderTransferFee: fee(older), newerTransferFee: fee(newer),
});
const pausable = (paused: boolean) => encode(PausableConfigLayout, { authority: key, paused });
const defaultState = (state: AccountState) => encode(DefaultAccountStateLayout, { state });
function mint(entries: [ExtensionType, Buffer][] = [], freezeAuthority: PublicKey | null = null): Mint {
  return { address: key, mintAuthority: null, supply: 0n, decimals: 6, isInitialized: true, freezeAuthority, tlvData: tlv(entries) };
}

describe("mint block reasons (shared by open path and RWA scan)", () => {
  it("no extensions (classic SPL mint): not blocked, even with a freeze authority", () => {
    expect(mintBlockReasons(mint([], key))).toEqual([]);
  });

  it("paused Token-2022 mint is blocked; an unpaused one is not", () => {
    expect(mintIsPaused(mint([[ExtensionType.PausableConfig, pausable(true)]]))).toBe(true);
    expect(mintBlockReasons(mint([[ExtensionType.PausableConfig, pausable(true)]]))).toEqual(["paused"]);
    expect(mintBlockReasons(mint([[ExtensionType.PausableConfig, pausable(false)]]))).toEqual([]);
  });

  it("transfer fee above 0 bps in either epoch slot is blocked; 0 bps is not", () => {
    expect(mintHasTransferFee(mint([[ExtensionType.TransferFeeConfig, transferFee(0, 0)]]))).toBe(false);
    expect(mintHasTransferFee(mint([[ExtensionType.TransferFeeConfig, transferFee(0, 5)]]))).toBe(true);
    expect(mintHasTransferFee(mint([[ExtensionType.TransferFeeConfig, transferFee(5, 0)]]))).toBe(true);
    expect(mintBlockReasons(mint([[ExtensionType.TransferFeeConfig, transferFee(0, 0)]]))).toEqual([]);
  });

  it("DefaultAccountState Frozen is blocked; Initialized (xStocks today) is not", () => {
    expect(mintDefaultFrozen(mint([[ExtensionType.DefaultAccountState, defaultState(AccountState.Frozen)]]))).toBe(true);
    expect(mintBlockReasons(mint([[ExtensionType.DefaultAccountState, defaultState(AccountState.Initialized)]]))).toEqual([]);
  });

  it("reports every reason in a fixed order", () => {
    expect(mintBlockReasons(mint([
      [ExtensionType.DefaultAccountState, defaultState(AccountState.Frozen)],
      [ExtensionType.TransferFeeConfig, transferFee(0, 1)],
      [ExtensionType.PausableConfig, pausable(true)],
    ]))).toEqual(["paused", "transfer_fee", "frozen"]);
  });
});

function scaledPayload(multiplier: number, newMultiplier: number): Buffer {
  const data = Buffer.alloc(56);
  data.writeDoubleLE(multiplier, 32);
  data.writeDoubleLE(newMultiplier, 48);
  return data;
}
function scaledMint(multiplier: number, newMultiplier = multiplier): Mint {
  return mint([[ExtensionType.ScaledUiAmountConfig, scaledPayload(multiplier, newMultiplier)]]);
}

describe("ScaledUiAmount multiplier tolerance", () => {
  it("is the single switch: 0.01 (shipped) or Infinity (no cap)", () => {
    expect(
      SCALED_UI_MULTIPLIER_TOLERANCE === 0.01
      || SCALED_UI_MULTIPLIER_TOLERANCE === Number.POSITIVE_INFINITY,
    ).toBe(true);
  });

  it("treats a missing config, a multiplier of 1, 1.003, and today's small dividend multipliers as supported", () => {
    expect(poolMintIssues(mint())).toEqual([]);
    expect(poolMintIssues(scaledMint(1, 1))).toEqual([]);
    expect(scaledUiAmountOutOfTolerance(scaledMint(1, 1))).toBe(false);
    expect(poolMintIssues(scaledMint(1.003))).toEqual([]);
    // Live values as of 2026-11-12 (Taipei): NVDAx, SPYon (largest).
    expect(poolMintIssues(scaledMint(1.0009180758490996, 1.001701196801074))).toEqual([]);
    expect(poolMintIssues(scaledMint(1.0094730727840426))).toEqual([]);
  });

  it("accepts a multiplier at the bound and rejects one further away, or any non-finite value", () => {
    const bound = SCALED_UI_MULTIPLIER_TOLERANCE;
    if (Number.isFinite(bound)) {
      expect(poolMintIssues(scaledMint(1 + bound))).toEqual([]);
      expect(poolMintIssues(scaledMint(1 - bound))).toEqual([]);
      expect(poolMintIssues(scaledMint(1 + bound + 0.000001))).toEqual(["ScaledUiAmount multiplier not 1"]);
      expect(poolMintIssues(scaledMint(1 - bound - 0.000001))).toEqual(["ScaledUiAmount multiplier not 1"]);
      expect(poolMintIssues(scaledMint(1, 1 + bound + 0.000001))).toEqual(["ScaledUiAmount multiplier not 1"]);
      expect(poolMintIssues(scaledMint(1 + bound + 0.000001, 1))).toEqual(["ScaledUiAmount multiplier not 1"]);
    } else {
      expect(poolMintIssues(scaledMint(2, 2))).toEqual([]);
      expect(poolMintIssues(scaledMint(0.5, 1))).toEqual([]);
    }
    expect(poolMintIssues(scaledMint(Number.NaN))).toEqual(["ScaledUiAmount multiplier not 1"]);
    expect(poolMintIssues(scaledMint(Number.POSITIVE_INFINITY))).toEqual(["ScaledUiAmount multiplier not 1"]);
  });

  it("leaves the other mint checks unchanged (paused still a block reason; hook still an issue)", () => {
    const paused = mint([
      [ExtensionType.PausableConfig, pausable(true)],
      [ExtensionType.ScaledUiAmountConfig, scaledPayload(1.0009, 1.0017)],
    ]);
    expect(mintBlockReasons(paused)).toEqual(["paused"]);
    expect(poolMintIssues(paused)).toEqual([]);
  });
});
