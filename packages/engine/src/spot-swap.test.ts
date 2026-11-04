import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionType, getAssociatedTokenAddressSync, getTypeLen, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type AccountInfo, type Connection } from "@solana/web3.js";
vi.mock("./swap/leg", () => ({ feeSwapLeg: vi.fn() }));
vi.mock("./rpc/fee-estimate", () => ({ estimateFeeForMessage: vi.fn(async () => 5_000), OPEN_FEE_ESTIMATE_MESSAGE: "x" }));
import { feeSwapLeg } from "./swap/leg";
import { JupiterNoRouteError } from "./swap/jupiter";
import { swapFeeRecipientAta } from "./swap/fee";
import { USDC_MINT } from "./ids";
import {
  assertSpotSwapAllowlist, buildAndSimulateSpotSwap, quoteSpotSwap, selectSpotSwapToken, spotSwapMintIssues, spotSwapTokenFor,
  verifySpotSwapSimulation, SpotSwapError, type SpotSwapAllowlist,
} from "./spot-swap";

const key = () => Keypair.generate().publicKey;
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const wallet = key(), feeWallet = key(), tsla = key(), tslaOther = key(), lookAlike = key(), nvda = key();
const usdc = new PublicKey(USDC_MINT);
const usdcAta = getAssociatedTokenAddressSync(usdc, wallet);
const outputAta = getAssociatedTokenAddressSync(tsla, wallet, false, TOKEN_2022_PROGRAM_ID);
const feeAta = swapFeeRecipientAta(feeWallet, usdc, TOKEN_PROGRAM_ID);
const RENT = 2_074_080;

const allowlist: SpotSwapAllowlist = [
  { mint: tslaOther.toBase58(), symbol: "TSLA", underlying: "TSLA", issuerName: "Other issuer", xstocks: false },
  { mint: tsla.toBase58(), symbol: "TSLAx", underlying: "TSLA", issuerName: "xStocks", xstocks: true },
  { mint: nvda.toBase58(), symbol: "NVDA", underlying: "NVDA", issuerName: "Other issuer", xstocks: false },
];

const info = (data: Buffer, owner: PublicKey = TOKEN_PROGRAM_ID, lamports = 2_039_280): AccountInfo<Buffer> => ({ data, owner, executable: false, lamports, rentEpoch: 0 });
function mint(decimals = 8) { const data = Buffer.alloc(82); data.writeBigUInt64LE(1000n, 36); data[44] = decimals; data[45] = 1; return data; }
function extendedMint(type: ExtensionType, fill: (payload: Buffer) => void) {
  const payload = Buffer.alloc(getTypeLen(type)); fill(payload);
  const data = Buffer.alloc(170 + payload.length); mint().copy(data); data[165] = 1;
  data.writeUInt16LE(type, 166); data.writeUInt16LE(payload.length, 168); payload.copy(data, 170); return data;
}
function token(m: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(165); m.toBuffer().copy(data); owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64); data[108] = 1; return data;
}

const accounts = new Map<string, AccountInfo<Buffer>>();
let post: { lamports: number; usdc: bigint; output: bigint | null; fee: bigint };
let slot = 100;
let feeMovesDuringSimulation = 0;
let feeBalance = 7_000n;
const sim = (data: Buffer, owner: PublicKey, lamports: number) => ({ data: [data.toString("base64"), "base64"], owner: owner.toBase58(), lamports, executable: false, rentEpoch: 0 });
const connection = {
  getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((k) => accounts.get(k.toBase58()) ?? null)),
  getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({ context: { slot: ++slot }, value: keys.map((k) => accounts.get(k.toBase58()) ?? null) })),
  getMinimumBalanceForRentExemption: vi.fn(async () => RENT),
  getLatestBlockhash: vi.fn(async () => ({ blockhash: key().toBase58(), lastValidBlockHeight: 999 })),
  simulateTransaction: vi.fn(async () => {
    if (feeMovesDuringSimulation > 0) {
      feeMovesDuringSimulation--;
      feeBalance += 1_000n;
      accounts.set(feeAta.toBase58(), info(token(usdc, feeWallet, feeBalance)));
    }
    return {
      context: { slot: ++slot },
      value: { err: null, unitsConsumed: 90_000, accounts: [
        { data: ["", "base64"], owner: SystemProgram.programId.toBase58(), lamports: post.lamports, executable: false },
        sim(token(usdc, wallet, post.usdc), TOKEN_PROGRAM_ID, 2_039_280),
        post.output === null ? null : sim(token(tsla, wallet, post.output), TOKEN_2022_PROGRAM_ID, RENT),
        sim(token(usdc, feeWallet, post.fee), TOKEN_PROGRAM_ID, 2_039_280),
      ] },
    };
  }),
} as unknown as Connection;

function route(amount: bigint) {
  return {
    inputMint: USDC_MINT, outputMint: tsla.toBase58(), inAmount: amount.toString(), outAmount: "522844", otherAmountThreshold: "520230",
    swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0.0003", platformFee: { amount: "523", feeBps: 10 },
    routePlan: [{ percent: 100, bps: 10_000, swapInfo: { ammKey: key().toBase58(), inputMint: USDC_MINT, outputMint: tsla.toBase58(), inAmount: "1", outAmount: "1" } }],
    computeBudgetInstructions: [], setupInstructions: [], cleanupInstruction: null, otherInstructions: [], tipInstruction: null,
    addressesByLookupTableAddress: {},
    swapInstruction: { programId: JUP, data: "", accounts: [
      { pubkey: wallet.toBase58(), isSigner: true, isWritable: true },
      { pubkey: usdcAta.toBase58(), isSigner: false, isWritable: true },
      { pubkey: outputAta.toBase58(), isSigner: false, isWritable: true },
      { pubkey: feeAta.toBase58(), isSigner: false, isWritable: true },
    ] },
  };
}
function mockLeg(overrides: Record<string, unknown> = {}) {
  vi.mocked(feeSwapLeg).mockImplementation(async (input) => ({
    inputMint: input.inputMint, outputMint: input.outputMint, spend: input.spend,
    feeAmount: input.spend * 10n / 10_000n, feeInRoute: true, minOut: 520_230n, route: route(input.spend) as never, ...overrides,
  }) as never);
}

const build = (amount = "2", mintAddress = tsla.toBase58()) => buildAndSimulateSpotSwap(wallet.toBase58(), mintAddress, amount, { allowlist, connection });
const code = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return (error as SpotSwapError).code ?? (error as Error).message; } return "resolved"; };

beforeEach(() => {
  vi.stubEnv("SOFINANCE_FEE_WALLET", feeWallet.toBase58()); vi.stubEnv("SOFINANCE_FEE_BPS", "10");
  vi.clearAllMocks(); accounts.clear(); slot = 100; feeMovesDuringSimulation = 0; feeBalance = 7_000n;
  accounts.set(wallet.toBase58(), info(Buffer.alloc(0), SystemProgram.programId, 50_000_000));
  accounts.set(tsla.toBase58(), info(mint(), TOKEN_2022_PROGRAM_ID));
  accounts.set(usdcAta.toBase58(), info(token(usdc, wallet, 5_000_000n)));
  accounts.set(feeAta.toBase58(), info(token(usdc, feeWallet, 7_000n)));
  // Correct simulation: -2 USDC, fee +2000 raw (0.1%), output 522,844, SOL -rent -fee.
  post = { lamports: 50_000_000 - RENT - 5_000, usdc: 3_000_000n, output: 522_844n, fee: 9_000n };
  mockLeg();
});
afterEach(() => vi.unstubAllEnvs());

describe("token allowlist (exact mint, never symbol)", () => {
  it("returns the allowlisted token for its exact mint", () => {
    expect(spotSwapTokenFor(allowlist, tsla.toBase58())).toMatchObject({ symbol: "TSLAx", issuerName: "xStocks" });
  });
  it("refuses a look-alike mint even when the symbol matches", () => {
    expect(() => spotSwapTokenFor(allowlist, lookAlike.toBase58())).toThrow(/not on the SoFinance stock token list/);
    expect(() => spotSwapTokenFor(allowlist, "TSLAx")).toThrow(/not on the SoFinance stock token list/);
    expect(() => spotSwapTokenFor(allowlist, ` ${tsla.toBase58()}`)).toThrow(/not on the SoFinance stock token list/);
  });
  it("rejects malformed allowlists", () => {
    const dup = [...allowlist, { ...allowlist[1]!, symbol: "TSLAX2" }];
    expect(() => assertSpotSwapAllowlist(dup)).toThrow(/repeats a mint/);
    expect(() => assertSpotSwapAllowlist([{ ...allowlist[0]!, mint: USDC_MINT }])).toThrow(/invalid mint/);
    expect(() => assertSpotSwapAllowlist([allowlist[1]!, { ...allowlist[0]!, xstocks: true }])).toThrow(/Two xStocks/);
    expect(() => assertSpotSwapAllowlist([{ ...allowlist[0]!, underlying: "tsla" }])).toThrow(/upper case/);
  });
});

describe("issuer selection (PM rule)", () => {
  it("defaults to the xStocks token even when another issuer is listed first", async () => {
    const hasRoute = vi.fn(async () => true);
    expect((await selectSpotSwapToken(allowlist, "tsla", hasRoute))?.mint).toBe(tsla.toBase58());
    expect(hasRoute).not.toHaveBeenCalled();
  });
  it("otherwise picks the first issuer token that has a Jupiter route", async () => {
    const second = key();
    const list = [allowlist[2]!, { mint: second.toBase58(), symbol: "NVDAz", underlying: "NVDA", issuerName: "Issuer B", xstocks: false }];
    expect((await selectSpotSwapToken(list, "NVDA", async (m) => m === second.toBase58()))?.issuerName).toBe("Issuer B");
    expect(await selectSpotSwapToken(list, "NVDA", async () => false)).toBeNull();
    expect(await selectSpotSwapToken(list, "AAPL", async () => true)).toBeNull();
  });
});

describe("Token-2022 mint rules (same as open)", () => {
  const issues = (data: Buffer) => spotSwapMintIssues(tsla, info(data, TOKEN_2022_PROGRAM_ID)).issues;
  it("accepts a plain mint and a ScaledUiAmount multiplier of 1", () => {
    expect(issues(mint())).toEqual([]);
    expect(issues(extendedMint(ExtensionType.ScaledUiAmountConfig, (p) => { p.writeDoubleLE(1, 32); p.writeDoubleLE(1, 48); }))).toEqual([]);
  });
  it("rejects a paused mint", () => {
    expect(issues(extendedMint(ExtensionType.PausableConfig, (p) => { p[32] = 1; }))).toContain("paused");
  });
  it("rejects a ScaledUiAmount multiplier other than 1", () => {
    expect(issues(extendedMint(ExtensionType.ScaledUiAmountConfig, (p) => { p.writeDoubleLE(2, 32); p.writeDoubleLE(2, 48); }))).toContain("ScaledUiAmount multiplier not 1");
  });
  it("rejects a transfer fee and a non-token owner", () => {
    expect(issues(extendedMint(ExtensionType.TransferFeeConfig, (p) => { p.writeUInt16LE(1, 88); p.writeUInt16LE(1, 106); }))).toContain("transfer_fee");
    expect(() => spotSwapMintIssues(tsla, info(mint(), SystemProgram.programId))).toThrow(/not an SPL/);
  });
});

describe("verifySpotSwapSimulation (exact)", () => {
  const pre = { lamports: 10_000_000n, usdc: 5_000_000n, output: 0n, fee: 7_000n };
  const good = { lamports: 9_000_000n, usdc: 3_000_000n, output: 522_844n, fee: 9_000n };
  const run = (p = good) => verifySpotSwapSimulation({ amount: 2_000_000n, feeAmount: 2_000n, minOut: 520_230n, maxSolDebit: 7_000_000n, pre, post: p });
  it("passes when fee, USDC and output match", () => {
    expect(run()).toEqual({ feeReceived: 2_000n, usdcSpent: 2_000_000n, received: 522_844n, solDebit: 1_000_000n });
  });
  it("rejects a fee one unit above or below the quote", () => {
    expect(() => run({ ...good, fee: 9_001n })).toThrow(expect.objectContaining({ code: "spot_swap_fee_mismatch" }));
    expect(() => run({ ...good, fee: 8_999n })).toThrow(expect.objectContaining({ code: "spot_swap_fee_mismatch" }));
  });
  it("rejects a USDC decrease that is not exactly the entered amount", () => {
    expect(() => run({ ...good, usdc: 2_999_999n })).toThrow(expect.objectContaining({ code: "spot_swap_usdc_mismatch" }));
    expect(() => run({ ...good, usdc: 3_000_001n })).toThrow(expect.objectContaining({ code: "spot_swap_usdc_mismatch" }));
  });
  it("rejects output below the minimum and an oversized SOL debit", () => {
    expect(() => run({ ...good, output: 520_229n })).toThrow(expect.objectContaining({ code: "spot_swap_min_out" }));
    expect(() => run({ ...good, lamports: 2_000_000n })).toThrow(expect.objectContaining({ code: "spot_swap_sol_debit" }));
  });
});

describe("buildAndSimulateSpotSwap", () => {
  it("builds a wallet-only transaction whose simulated fee equals the quote", async () => {
    const { summary, transaction } = await build("2");
    expect(transaction.message.header.numRequiredSignatures).toBe(1);
    expect(transaction.message.staticAccountKeys[0]!.equals(wallet)).toBe(true);
    expect(summary).toMatchObject({
      operation: "spot-swap", outputMint: tsla.toBase58(), outputSymbol: "TSLAx", issuerName: "xStocks", xstocks: true,
      amount: "2000000", feeBps: 10, feeAmount: "2000", quotedOut: "522844", minOut: "520230", simulatedOut: "522844",
      outputProgram: TOKEN_2022_PROGRAM_ID.toBase58(), outputAccount: outputAta.toBase58(),
    });
    expect(summary.feeWalletShort).toMatch(/^.{4}….{2}$/);
    expect(JSON.stringify(summary)).not.toContain(feeWallet.toBase58());
    expect(summary.solRequirement).toEqual({
      outputAccountExists: false, outputAccountRentLamports: String(RENT), networkFeeLamports: "5000",
      requiredLamports: String(RENT + 5_000 + 5_000), walletLamports: "50000000", sufficient: true,
    });
    expect(vi.mocked(feeSwapLeg)).toHaveBeenCalledWith(expect.objectContaining({ inputMint: USDC_MINT, spend: 2_000_000n, feeBps: 10, inputFee: true, build: true }));
  });
  it("needs no account deposit when the wallet already holds the token", async () => {
    accounts.set(outputAta.toBase58(), info(token(tsla, wallet, 10n), TOKEN_2022_PROGRAM_ID, RENT));
    post = { ...post, lamports: 50_000_000 - 5_000, output: 522_854n };
    const { summary } = await build("2");
    expect(summary.solRequirement).toMatchObject({ outputAccountExists: true, outputAccountRentLamports: "0" });
    expect(summary.simulatedOut).toBe("522844");
  });
  it("rejects a simulation whose fee differs from the quote", async () => {
    post = { ...post, fee: 9_001n };
    expect(await code(build())).toBe("spot_swap_fee_mismatch");
  });
  it("rejects a simulation whose USDC decrease differs from the entered amount", async () => {
    post = { ...post, usdc: 2_999_000n };
    expect(await code(build())).toBe("spot_swap_usdc_mismatch");
  });
  it("rejects a route that does not charge the quoted fee", async () => {
    mockLeg({ feeAmount: 1_999n });
    expect(await code(build())).toBe("spot_swap_fee_mismatch");
    mockLeg({ feeInRoute: false });
    expect(await code(build())).toBe("spot_swap_fee_mismatch");
  });
  it("rejects a route whose swap does not write the fee account", async () => {
    vi.mocked(feeSwapLeg).mockImplementation(async (input) => {
      const r = route(input.spend);
      r.swapInstruction.accounts = r.swapInstruction.accounts.filter((a) => a.pubkey !== feeAta.toBase58());
      return { inputMint: USDC_MINT, outputMint: input.outputMint, spend: input.spend, feeAmount: 2_000n, feeInRoute: true, minOut: 520_230n, route: r } as never;
    });
    expect(await code(build())).toBe("spot_swap_fee_mismatch");
  });
  it("rejects a route with a second signer", async () => {
    vi.mocked(feeSwapLeg).mockImplementation(async (input) => {
      const r = route(input.spend);
      r.swapInstruction.accounts.push({ pubkey: key().toBase58(), isSigner: true, isWritable: false });
      return { inputMint: USDC_MINT, outputMint: input.outputMint, spend: input.spend, feeAmount: 2_000n, feeInRoute: true, minOut: 520_230n, route: r } as never;
    });
    expect(await code(build())).toBe("Route contains non-wallet signer");
  });
  it("refuses a look-alike mint before any RPC or Jupiter call", async () => {
    expect(await code(build("2", lookAlike.toBase58()))).toBe("spot_swap_token_not_allowed");
    expect(connection.getMultipleAccountsInfo).not.toHaveBeenCalled();
    expect(feeSwapLeg).not.toHaveBeenCalled();
  });
  it("refuses paused and re-scaled mints before quoting", async () => {
    accounts.set(tsla.toBase58(), info(extendedMint(ExtensionType.PausableConfig, (p) => { p[32] = 1; }), TOKEN_2022_PROGRAM_ID));
    expect(await code(build())).toBe("spot_swap_token_unavailable");
    accounts.set(tsla.toBase58(), info(extendedMint(ExtensionType.ScaledUiAmountConfig, (p) => { p.writeDoubleLE(1, 32); p.writeDoubleLE(1.5, 48); }), TOKEN_2022_PROGRAM_ID));
    expect(await code(build())).toBe("spot_swap_token_unavailable");
    expect(feeSwapLeg).not.toHaveBeenCalled();
  });
  it("reports the SOL needed when the wallet cannot pay the account deposit", async () => {
    accounts.set(wallet.toBase58(), info(Buffer.alloc(0), SystemProgram.programId, 1_000_000));
    await expect(build()).rejects.toMatchObject({ code: "spot_swap_insufficient_sol",
      detail: { outputAccountRentLamports: String(RENT), requiredLamports: String(RENT + 5_000), walletLamports: "1000000", sufficient: false } });
  });
  it("refuses without USDC, without a fee wallet, and below the 1-unit fee", async () => {
    expect(await code(build("6"))).toBe("spot_swap_insufficient_usdc");
    expect(await code(build("0.000999"))).toBe("spot_swap_amount_too_small");
    vi.stubEnv("SOFINANCE_FEE_WALLET", "");
    expect(await code(build())).toBe("spot_swap_fee_not_configured");
  });
  it("re-reads the pre-balance when another fee lands during the check, then checks exactly", async () => {
    feeMovesDuringSimulation = 1;
    post = { ...post, fee: 8_000n + 2_000n };
    const { summary } = await build();
    expect(summary.feeAmount).toBe("2000");
    expect(connection.simulateTransaction).toHaveBeenCalledTimes(2);
  });
  it("fails closed when balances keep moving", async () => {
    feeMovesDuringSimulation = 5;
    expect(await code(build())).toBe("spot_swap_state_changed");
    expect(connection.simulateTransaction).toHaveBeenCalledTimes(3);
  });
});

describe("quoteSpotSwap", () => {
  it("previews fee, output and the new-account deposit without a wallet", async () => {
    const quote = await quoteSpotSwap(tsla.toBase58(), "2", { allowlist, connection });
    expect(quote).toMatchObject({ feeAmount: "2000", feeBps: 10, quotedOut: "522844", minOut: "520230", newAccountRentLamports: String(RENT), issuerName: "xStocks" });
    expect(vi.mocked(feeSwapLeg)).toHaveBeenCalledWith(expect.objectContaining({ build: false, inputFee: true }));
  });
  it("maps a missing route to the Jupiter no-route error", async () => {
    vi.mocked(feeSwapLeg).mockRejectedValue(new JupiterNoRouteError());
    await expect(quoteSpotSwap(tsla.toBase58(), "2", { allowlist, connection })).rejects.toBeInstanceOf(JupiterNoRouteError);
  });
});
