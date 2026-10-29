import { ACCOUNT_SIZE, AccountLayout, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import fixture from "../../packages/engine/src/fixtures/meteora-dlmm-accounts-cbbtc-wbtc.json";
import { decodeLbPair, meteoraBinArrayAddress, meteoraBinArrayIndex, METEORA_BINS_PER_ARRAY } from "@sofinance/engine/protocols/meteora/accounts";
import { CBBTC_MINT, METEORA_DLMM_PROGRAM_ID, WBTC_WORMHOLE_MINT } from "@sofinance/engine/protocols/meteora/constants";
import { SwapFeeAccountMissingError } from "@sofinance/engine/swap/collection";
import { DirectFeeWalletInstructionError, type SwapFeeConfig } from "@sofinance/engine/swap/fee";
import type { feeSwapLeg } from "@sofinance/engine/swap/leg";

vi.mock("server-only", () => ({}));

const {
  assertMeteoraFeeRule, MeteoraOpenBlockedError, MeteoraSystemTransferError, meteoraSetupInstructions, planMeteoraLegs, prepareMeteoraSetup, readMeteoraOpenState,
} = await import("./meteora-open");

const POOL = "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WALLET = Keypair.generate().publicKey;
const FEE_WALLET = Keypair.generate().publicKey;
const accounts = fixture.accounts as Record<string, { owner: string; data: string } | null>;
const lb = decodeLbPair(Buffer.from(accounts[POOL]!.data, "base64"));
const existingArrays = Object.entries(accounts).filter(([, v]) => v?.owner === METEORA_DLMM_PROGRAM_ID && v.data.length > 10_000).map(([k]) => k);
// A range around the active bin inside one existing bin array.
const activeArray = meteoraBinArrayIndex(lb.activeId);
const range = { lowerBinId: Math.max(activeArray * METEORA_BINS_PER_ARRAY, lb.activeId - 3), upperBinId: Math.min((activeArray + 1) * METEORA_BINS_PER_ARRAY - 1, lb.activeId + 3) };
const feeConfig = (): SwapFeeConfig => ({ wallet: FEE_WALLET, bps: 10 });

function tokenAccount(mint: string, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode({
    mint: new PublicKey(mint), owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default,
  }, data);
  return { owner: TOKEN_PROGRAM_ID, data, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

function fakeConnection(options: { walletLamports: number; inputMint: string; balance?: bigint }) {
  const inputAta = getAssociatedTokenAddressSync(new PublicKey(options.inputMint), WALLET).toBase58();
  const simulateTransaction = vi.fn(async () => { throw new Error("must not simulate"); });
  const connection = {
    getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({
      context: { slot: fixture.slot },
      value: keys.map((key) => {
        const k = key.toBase58();
        if (k === WALLET.toBase58()) return { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: options.walletLamports, executable: false, rentEpoch: 0 };
        if (k === inputAta) return tokenAccount(options.inputMint, WALLET, options.balance ?? 10_000_000_000n);
        const a = accounts[k];
        return a ? { owner: new PublicKey(a.owner), data: Buffer.from(a.data, "base64"), lamports: 1, executable: false, rentEpoch: 0 } : null;
      }),
    })),
    getMinimumBalanceForRentExemption: vi.fn(async (space: number) => (space + 128) * 6960),
    getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 })),
    getAddressLookupTable: vi.fn(async () => ({ value: null })),
    simulateTransaction,
  };
  return { connection: connection as unknown as Connection, simulateTransaction };
}

function fakeLeg() {
  return vi.fn<typeof feeSwapLeg>(async (input) => ({
    inputMint: input.inputMint, outputMint: input.outputMint, spend: input.spend,
    feeAmount: input.inputFee ? (input.spend * BigInt(input.feeBps)) / 10_000n : 0n, feeInRoute: Boolean(input.inputFee),
    minOut: input.spend / 1000n, route: null,
  }) as Awaited<ReturnType<typeof feeSwapLeg>>);
}

const params = (inputMint: string, extra: Partial<{ lowerBinId: number; upperBinId: number; amount: bigint }> = {}) => ({
  wallet: WALLET.toBase58(), poolId: POOL, inputMint, amount: 2_000_000n, position: Keypair.generate().publicKey.toBase58(), ...range, ...extra,
});

describe("Meteora open fee rule (10 bps on the swapped portion, inside Jupiter)", () => {
  it("charges every swapped leg through Jupiter's input-mint platform fee and leaves a kept portion uncharged", async () => {
    const swapLeg = fakeLeg();
    const usdc = await planMeteoraLegs(params(USDC), { pool: (await import("@sofinance/engine/protocols/meteora/constants")).METEORA_ALLOWLISTED_POOLS[0]!, lbPair: lb }, { feeConfig, swapLeg }, { build: true });
    expect(usdc.legs.every((leg) => leg.swapped && leg.feeBps === 10 && BigInt(leg.feeAmount) > 0n)).toBe(true);
    for (const call of swapLeg.mock.calls) expect(call[0]).toMatchObject({ feeBps: 10, inputFee: true });

    const kept = await planMeteoraLegs(params(CBBTC_MINT), { pool: (await import("@sofinance/engine/protocols/meteora/constants")).METEORA_ALLOWLISTED_POOLS[0]!, lbPair: lb }, { feeConfig, swapLeg: fakeLeg() }, { build: true });
    const x = kept.legs.find((leg) => leg.side === "x")!;
    const y = kept.legs.find((leg) => leg.side === "y")!;
    expect(x).toMatchObject({ swapped: false, feeBps: 0, feeAmount: "0", minOut: x.spend });
    expect(y).toMatchObject({ swapped: true, feeBps: 10, outputMint: WBTC_WORMHOLE_MINT });
  });

  it("refuses a route whose fee is not collected inside the Jupiter swap", async () => {
    const swapLeg = vi.fn<typeof feeSwapLeg>(async (input) => ({ inputMint: input.inputMint, outputMint: input.outputMint, spend: input.spend, feeAmount: 0n, feeInRoute: false, minOut: 1n, route: null }) as Awaited<ReturnType<typeof feeSwapLeg>>);
    const { connection } = fakeConnection({ walletLamports: 1e9, inputMint: USDC });
    await expect(prepareMeteoraSetup(params(USDC), { connection, feeConfig, swapLeg })).rejects.toThrow(/fee is not collected inside the Jupiter swap/);
  });

  it("builds nothing when the fee wallet's input-mint ATA is missing (no fee-wallet ATA is ever created)", async () => {
    const swapLeg = vi.fn<typeof feeSwapLeg>(async () => { throw new SwapFeeAccountMissingError(false); });
    const { connection, simulateTransaction } = fakeConnection({ walletLamports: 1e9, inputMint: USDC });
    await expect(prepareMeteoraSetup(params(USDC), { connection, feeConfig, swapLeg })).rejects.toBeInstanceOf(SwapFeeAccountMissingError);
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it("guard rejects direct fee-wallet transfers, fee-wallet ATA creation and bare SystemProgram transfers", () => {
    const config = feeConfig();
    expect(() => assertMeteoraFeeRule([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: FEE_WALLET, lamports: 1 })], config)).toThrow(DirectFeeWalletInstructionError);
    const feeAta = getAssociatedTokenAddressSync(new PublicKey(USDC), FEE_WALLET);
    expect(() => assertMeteoraFeeRule([createAssociatedTokenAccountIdempotentInstruction(WALLET, feeAta, FEE_WALLET, new PublicKey(USDC))], config)).toThrow(DirectFeeWalletInstructionError);
    expect(() => assertMeteoraFeeRule([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: Keypair.generate().publicKey, lamports: 1 })], config)).toThrow(MeteoraSystemTransferError);
  });

  it("1/2 only creates the wallet's own accounts, with no SystemProgram transfer", async () => {
    const { connection } = fakeConnection({ walletLamports: 1e9, inputMint: USDC });
    const p = params(USDC);
    const state = await readMeteoraOpenState(connection, p);
    const ixs = meteoraSetupInstructions(p, state);
    expect(() => assertMeteoraFeeRule(ixs, feeConfig())).not.toThrow();
    for (const ix of ixs) {
      expect(ix.programId.equals(SystemProgram.programId)).toBe(false);
      if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) expect(ix.keys[2]!.pubkey.equals(WALLET)).toBe(true);
    }
    const init = ixs.at(-1)!;
    expect(init.programId.toBase58()).toBe(METEORA_DLMM_PROGRAM_ID);
    expect(init.keys[0]!.pubkey.equals(WALLET)).toBe(true); // payer: rent paid by the wallet
    expect(init.keys[3]!.pubkey.equals(WALLET)).toBe(true); // owner: close_position2 refunds the rent to it
  });
});

describe("Meteora open blocks", () => {
  it("rejects native SOL and unsupported inputs", async () => {
    const { connection } = fakeConnection({ walletLamports: 1e9, inputMint: USDC });
    await expect(prepareMeteoraSetup(params("So11111111111111111111111111111111111111112"), { connection, feeConfig, swapLeg: fakeLeg() })).rejects.toMatchObject({ code: "sol_input_unavailable" });
    await expect(prepareMeteoraSetup(params(Keypair.generate().publicKey.toBase58()), { connection, feeConfig, swapLeg: fakeLeg() })).rejects.toMatchObject({ code: "input_not_supported" });
  });

  it("blocks ranges that would need a new bin array", async () => {
    const missingIndex = [...Array(400).keys()].map((i) => activeArray + 1 + i).find((i) => !existingArrays.includes(meteoraBinArrayAddress(POOL, i)))!;
    const lower = missingIndex * METEORA_BINS_PER_ARRAY;
    const { connection } = fakeConnection({ walletLamports: 1e9, inputMint: USDC });
    await expect(prepareMeteoraSetup(params(USDC, { lowerBinId: lower, upperBinId: lower + 5 }), { connection, feeConfig, swapLeg: fakeLeg() }))
      .rejects.toMatchObject({ code: "bin_array_missing" });
  });

  it("includes the estimated rent in the minimum SOL check and blocks before simulating", async () => {
    const { connection, simulateTransaction } = fakeConnection({ walletLamports: 14_155_540, inputMint: USDC });
    const error = await prepareMeteoraSetup(params(USDC), { connection, feeConfig, swapLeg: fakeLeg() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeteoraOpenBlockedError);
    const blocked = error as InstanceType<typeof MeteoraOpenBlockedError> & { rent: Record<string, string>; minimum: Record<string, unknown> };
    expect(blocked.code).toBe("sol_insufficient");
    const positionRent = (8120 + 128) * 6960;
    const ataRent = (165 + 128) * 6960;
    expect(blocked.rent).toMatchObject({ positionLamports: String(positionRent), tokenAccountLamports: String(2 * ataRent), binArrayLamports: "0", refundableLamports: String(positionRent) });
    expect(BigInt(blocked.minimum.requiredLamports as string)).toBeGreaterThan(BigInt(positionRent + 2 * ataRent + 10_000_000));
    expect(blocked.minimum.ok).toBe(false);
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it("blocks when the input balance is lower than the amount", async () => {
    const { connection } = fakeConnection({ walletLamports: 1e9, inputMint: USDC, balance: 1n });
    await expect(prepareMeteoraSetup(params(USDC), { connection, feeConfig, swapLeg: fakeLeg() })).rejects.toMatchObject({ code: "input_balance_insufficient" });
  });
});
