import { AccountLayout, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/swap/jupiter", () => ({ buildRoute: vi.fn() }));
vi.mock("@sofinance/engine/open-transaction", () => ({ versionedTransactionSize: vi.fn() }));
import { versionedTransactionSize } from "@sofinance/engine/open-transaction";
import { collectInputAssetFee, collectSwapFee, feeAccountSetup, fitFeeCollections, wrapNativeSolInstructions } from "@sofinance/engine/swap/collection";
import { nativeSolOwnerAta } from "@sofinance/engine/swap/fee";
import { depositFeePlan } from "@sofinance/engine/swap/leg";
import { buildRoute } from "@sofinance/engine/swap/jupiter";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
const owner = Keypair.generate().publicKey, recipient = Keypair.generate().publicKey;
const mint = new PublicKey(USDC_MINT);
it("deposits pay once in the input mint, including same-mint allocation and sequential secondary swaps", () => {
  expect(depositFeePlan(USDC_MINT, 1000000n, { wallet: recipient, bps: 10 }))
    .toEqual({ feeAmount: 1000n, swapAmount: 999000n, legBps: 0, secondaryBps: 0 });
  expect(depositFeePlan(Keypair.generate().publicKey.toBase58(), 1000000n, { wallet: recipient, bps: 10 }))
    .toEqual({ feeAmount: 1000n, swapAmount: 999000n, legBps: 0, secondaryBps: 0 });
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
it("collects native SOL as wSOL TransferChecked with user-paid fee ATA create", async () => {
  const result = await collectInputAssetFee({ getAccountInfo: vi.fn(async () => null) } as never,
    { kind: "native", payer: owner, owner, recipient, amount: 1000n });
  expect(result.routes).toEqual([]);
  expect(vi.mocked(buildRoute)).not.toHaveBeenCalled();
  expect(result.instructions).toHaveLength(2);
  expect(result.instructions[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  expect(result.instructions[0]!.data[0]).toBe(1);
  expect(result.instructions[0]!.keys[0]!.pubkey.equals(owner)).toBe(true);
  expect(result.instructions[0]!.keys[2]!.pubkey.equals(recipient)).toBe(true);
  expect(result.instructions[0]!.keys[3]!.pubkey.toBase58()).toBe(NATIVE_SOL_MINT);
  expect(result.instructions[1]!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
  expect(result.instructions[1]!.data[0]).toBe(12);
  expect(result.instructions[1]!.data.readBigUInt64LE(1)).toBe(1000n);
  expect(result.instructions.some(ix => ix.programId.equals(SystemProgram.programId))).toBe(false);
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

it("measures with Beam tip and replaces only an oversized conversion", async () => {
  const routeInstruction = SystemProgram.transfer({ fromPubkey: owner, toPubkey: recipient, lamports: 1 });
  const tip = SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 100000 });
  const input = { payer: owner, owner, recipient, amount: 1000n, kind: "native" as const };
  const connection = { getAccountInfo: vi.fn(async () => null) };
  const compile = vi.fn(() => ({} as never));
  vi.mocked(versionedTransactionSize).mockReturnValue(1300);
  const result = await fitFeeCollections(connection as never,
    [{ instructions: [routeInstruction], routes: [], input }], [routeInstruction], compile, tip);
  expect(compile).toHaveBeenCalledWith([routeInstruction, tip]);
  expect(result.fallback).toBe(true);
  expect(result.usdcCandidateBytes).toBe(1300);
  expect(result.instructions[0]!.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
  expect(result.instructions[1]!.data.readBigUInt64LE(1)).toBe(1000n);
  expect(result.instructions.some(ix => ix.programId.equals(SystemProgram.programId) && ix.keys[1]?.pubkey.equals(recipient))).toBe(false);
  vi.mocked(versionedTransactionSize).mockReturnValue(1200);
  expect((await fitFeeCollections(connection as never,
    [{ instructions: [routeInstruction], routes: [], input }], [routeInstruction], compile, tip)).fallback).toBe(false);
});
