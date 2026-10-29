// Native SOL input pays the 10 bps protocol fee as Jupiter's input-mint
// platform fee into the operator's pre-created wSOL ATA (LJ, 2026-10-29).
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => ({ getAccountInfo: vi.fn() }));
vi.mock("./client", () => ({ jupiterQuote: vi.fn(), jupiterSwapInstructions: vi.fn() }));
vi.mock("../rpc", () => ({ rpcConnection: () => rpc }));
vi.mock("../config/server-env", () => ({ getJupiterApiKey: () => "test-key" }));
import { jupiterQuote, jupiterSwapInstructions } from "./client";
import { feeSwapLeg } from "./leg";
import { NATIVE_SOL_MINT, SLIPPAGE_BPS } from "../ids";

const feeWallet = Keypair.generate().publicKey;
const wallet = Keypair.generate().publicKey.toBase58();
const outputMint = Keypair.generate().publicKey.toBase58();
const wsol = new PublicKey(NATIVE_SOL_MINT);
const feeAta = getAssociatedTokenAddressSync(wsol, feeWallet, true, TOKEN_PROGRAM_ID).toBase58();
const spend = 30_000_123n;

function wsolAccount() {
  const data = Buffer.alloc(165);
  AccountLayout.encode({ mint: wsol, owner: feeWallet, amount: 0n, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 1, isNative: 2039280n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 2039280, executable: false };
}

function quote(inputMint = NATIVE_SOL_MINT) {
  return { inputMint, outputMint, inAmount: spend.toString(), outAmount: "1000", otherAmountThreshold: "995",
    swapMode: "ExactIn", slippageBps: SLIPPAGE_BPS, priceImpactPct: "0.001", platformFee: { amount: "1", feeBps: 10 },
    routePlan: [{ percent: 100, bps: 10000, swapInfo: { ammKey: "a", inputMint, outputMint, inAmount: spend.toString(), outAmount: "1000" } }] };
}

function swapInstructions(feeAccount: string) {
  return { computeBudgetInstructions: [], setupInstructions: [], cleanupInstruction: null, otherInstructions: [], addressLookupTableAddresses: [],
    swapInstruction: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", data: "", accounts: [
      { pubkey: wallet, isSigner: true, isWritable: false }, { pubkey: feeAccount, isSigner: false, isWritable: true }] } };
}

beforeEach(() => {
  vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet.toBase58());
  vi.stubEnv("SOFINANCE_FEE_BPS", "10");
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("charges 10 bps of the full SOL leg inside the swap, into the pre-created fee wSOL ATA, with no setup instruction", async () => {
  rpc.getAccountInfo.mockResolvedValue(wsolAccount());
  vi.mocked(jupiterQuote).mockResolvedValue(quote());
  vi.mocked(jupiterSwapInstructions).mockResolvedValue(swapInstructions(feeAta));
  const leg = await feeSwapLeg({ wallet, inputMint: NATIVE_SOL_MINT, outputMint, spend, feeBps: 10, inputFee: true });
  // ExactIn input-mint fee: Jupiter takes floor(inAmount * 10 / 10_000) from the gross spend.
  expect(leg.feeAmount).toBe(30_000n);
  expect(leg.feeInRoute).toBe(true);
  expect(leg.route!.inAmount).toBe(spend.toString());
  expect(jupiterQuote).toHaveBeenCalledWith(expect.objectContaining({ amount: spend.toString(), platformFeeBps: 10 }));
  expect(jupiterSwapInstructions).toHaveBeenCalledWith(expect.objectContaining({ feeAccount: feeAta, wrapAndUnwrapSol: false }), expect.anything());
  expect((leg.route as { setupInstructions?: unknown[] }).setupInstructions).toEqual([]);
});

it("fails closed when the fee wSOL ATA is missing: no swap is built and nothing is created", async () => {
  rpc.getAccountInfo.mockResolvedValue(null);
  vi.mocked(jupiterQuote).mockResolvedValue(quote());
  await expect(feeSwapLeg({ wallet, inputMint: NATIVE_SOL_MINT, outputMint, spend, feeBps: 10, inputFee: true }))
    .rejects.toThrow("Protocol fee wSOL account is not set up");
  expect(jupiterSwapInstructions).not.toHaveBeenCalled();
});

it("rejects a swap that does not pay the fee wSOL account", async () => {
  rpc.getAccountInfo.mockResolvedValue(wsolAccount());
  vi.mocked(jupiterQuote).mockResolvedValue(quote());
  vi.mocked(jupiterSwapInstructions).mockResolvedValue(swapInstructions(Keypair.generate().publicKey.toBase58()));
  await expect(feeSwapLeg({ wallet, inputMint: NATIVE_SOL_MINT, outputMint, spend, feeBps: 10, inputFee: true }))
    .rejects.toThrow("does not pay the protocol fee account");
});

it("token inputs also pay the fee inside Jupiter: input-mint platform fee on the full spend", async () => {
  const token = Keypair.generate().publicKey.toBase58();
  vi.mocked(jupiterQuote).mockResolvedValue({ ...quote(token), inAmount: "1000000" });
  const leg = await feeSwapLeg({ wallet, inputMint: token, outputMint, spend: 1_000_000n, feeBps: 10, inputFee: true, build: false });
  expect(leg.feeInRoute).toBe(true);
  expect(leg.feeAmount).toBe(1000n);
  expect(jupiterQuote).toHaveBeenCalledWith(expect.objectContaining({ amount: "1000000", platformFeeBps: 10 }));
});
