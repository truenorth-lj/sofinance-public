import { AccountLayout, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/swap/jupiter", () => ({ buildRoute: vi.fn() }));
vi.mock("@sofinance/engine/open-transaction", () => ({ versionedTransactionSize: vi.fn() }));
import { versionedTransactionSize } from "@sofinance/engine/open-transaction";
import { collectInputAssetFee, collectSwapFee, feeAccountSetup, fitFeeCollections, requireSwapFeeAccount, wrapNativeSolInstructions } from "@sofinance/engine/swap/collection";
import { nativeSolOwnerAta } from "@sofinance/engine/swap/fee";
import { assertNativeInputFeeCoverage, depositFeePlan } from "@sofinance/engine/swap/leg";
import { buildRoute } from "@sofinance/engine/swap/jupiter";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
const owner = Keypair.generate().publicKey, recipient = Keypair.generate().publicKey;
const mint = new PublicKey(USDC_MINT);
it("deposits reserve nothing up front: every input-mint swap leg is charged inside Jupiter, whatever the input", () => {
  expect(depositFeePlan(1000000n, { wallet: recipient, bps: 10 }))
    .toEqual({ feeAmount: 0n, swapAmount: 1000000n, legBps: 10, secondaryBps: 0, inputFee: true });
  expect(depositFeePlan(1000000n, { wallet: null, bps: 0 }))
    .toEqual({ feeAmount: 0n, swapAmount: 1000000n, legBps: 0, secondaryBps: 0, inputFee: false });
});
it("refuses native SOL kept unswapped (SOL pools) instead of leaving it uncharged", () => {
  const swapped = { inputMint: NATIVE_SOL_MINT, outputMint: USDC_MINT, spend: 10n };
  const kept = { inputMint: NATIVE_SOL_MINT, outputMint: NATIVE_SOL_MINT, spend: 10n };
  expect(() => assertNativeInputFeeCoverage(true, [swapped])).not.toThrow();
  expect(() => assertNativeInputFeeCoverage(true, [kept, swapped])).toThrow("SOL input is not available for pools that contain SOL");
  expect(() => assertNativeInputFeeCoverage(false, [kept, swapped])).not.toThrow();
});
it("collects a non-USDC deposit as an input-mint transfer without a Jupiter hop", async () => {
  const inputMint = Keypair.generate().publicKey;
  const result = await collectInputAssetFee({ getAccountInfo: vi.fn(async () => null) } as never,
    { kind: "token", payer: owner, owner, recipient, mint: inputMint, amount: 1000n,
      source: Keypair.generate().publicKey, decimals: 6, program: TOKEN_PROGRAM_ID });
  expect(result.routes).toEqual([]);
  expect(vi.mocked(buildRoute)).not.toHaveBeenCalled();
  expect(result.instructions).toHaveLength(2);
  expect(result.instructions[1]!.data.readBigUInt64LE(1)).toBe(1000n);
});
it("creates missing USDC ATA with user payer before transferring the upfront fee", async () => {
  const result = await collectSwapFee({ getAccountInfo: vi.fn(async () => null) } as never,
    { kind: "token", payer: owner, owner, recipient, mint, amount: 1000n,
      source: Keypair.generate().publicKey, decimals: 6, program: TOKEN_PROGRAM_ID });
  expect(result.routes).toEqual([]);
  expect(result.instructions).toHaveLength(2);
  expect(result.instructions[0]!.data[0]).toBe(1);
  expect(result.instructions[0]!.keys[0]!.pubkey.equals(owner)).toBe(true);
  expect(result.instructions[1]!.data.readBigUInt64LE(1)).toBe(1000n);
});
it("never builds a direct SOL/wSOL fee transfer or fee-wallet ATA create for native SOL input", async () => {
  await expect(collectInputAssetFee({ getAccountInfo: vi.fn(async () => null) } as never,
    { kind: "native", payer: owner, owner, recipient, amount: 1000n })).rejects.toThrow("inside the Jupiter swap");
  await expect(collectSwapFee({ getAccountInfo: vi.fn(async () => null) } as never,
    { kind: "native", payer: owner, owner, recipient, amount: 1000n })).rejects.toThrow("inside the Jupiter swap");
  expect(vi.mocked(buildRoute)).not.toHaveBeenCalled();
});
it("requires the pre-created fee wSOL ATA and never creates it", async () => {
  await expect(requireSwapFeeAccount({ getAccountInfo: vi.fn(async () => null) } as never, recipient))
    .rejects.toThrow("Protocol fee wSOL account is not set up");
  const wsol = new PublicKey(NATIVE_SOL_MINT);
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint: wsol, owner: recipient, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 1, isNative: 2039280n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  const address = await requireSwapFeeAccount({ getAccountInfo: vi.fn(async () => ({ data, owner: TOKEN_PROGRAM_ID })) } as never, recipient);
  expect(address.equals(getAssociatedTokenAddressSync(wsol, recipient, true, TOKEN_PROGRAM_ID))).toBe(true);
});
it("wraps the full native SOL input into the user's wSOL ATA", () => {
  const ixs = wrapNativeSolInstructions(owner, 1_000_000n);
  expect(ixs).toHaveLength(3);
  expect(ixs[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  expect(ixs[1]!.programId.equals(SystemProgram.programId)).toBe(true);
  expect(ixs[1]!.keys[0]!.pubkey.equals(owner)).toBe(true);
  expect(ixs[1]!.keys[1]!.pubkey.equals(nativeSolOwnerAta(owner))).toBe(true);
  expect(ixs[1]!.data.readBigUInt64LE(4)).toBe(1_000_000n);
});
it.each([1, 2])("validates existing USDC ATA state=%s", async state => {
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint, owner: recipient, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
    state, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  const connection = { getAccountInfo: vi.fn(async () => ({ data, owner: TOKEN_PROGRAM_ID })) };
  if (state === 2) await expect(feeAccountSetup(connection as never, owner, recipient)).rejects.toThrow("invalid or frozen");
  else expect((await feeAccountSetup(connection as never, owner, recipient)).instructions).toEqual([]);
});

it("measures the candidate and replaces only an oversized conversion", async () => {
  const routeInstruction = SystemProgram.transfer({ fromPubkey: owner, toPubkey: recipient, lamports: 1 });
  const input = { payer: owner, owner, recipient, amount: 1000n, kind: "token" as const,
    mint: Keypair.generate().publicKey, source: Keypair.generate().publicKey, decimals: 6, program: TOKEN_PROGRAM_ID };
  const connection = { getAccountInfo: vi.fn(async () => null) };
  const compile = vi.fn(() => ({} as never));
  vi.mocked(versionedTransactionSize).mockReturnValue(1300);
  const result = await fitFeeCollections(connection as never,
    [{ instructions: [routeInstruction], routes: [], input }], [routeInstruction], compile);
  expect(compile).toHaveBeenCalledWith([routeInstruction]);
  expect(result.fallback).toBe(true);
  expect(result.usdcCandidateBytes).toBe(1300);
  expect(result.instructions[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  expect(result.instructions[1]!.data.readBigUInt64LE(1)).toBe(1000n);
  expect(result.instructions.some(ix => ix.programId.equals(SystemProgram.programId) && ix.keys[1]?.pubkey.equals(recipient))).toBe(false);
  vi.mocked(versionedTransactionSize).mockReturnValue(1200);
  expect((await fitFeeCollections(connection as never,
    [{ instructions: [routeInstruction], routes: [], input }], [routeInstruction], compile)).fallback).toBe(false);
});
