import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionType, getAssociatedTokenAddressSync, getExtensionTypes, getTypeLen, unpackMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, type AccountInfo, type Connection } from "@solana/web3.js";
vi.mock("./swap/leg", () => ({ feeSwapLeg: vi.fn() }));
vi.mock("./rpc/fee-estimate", () => ({ estimateFeeForMessage: vi.fn(async () => 5_000), OPEN_FEE_ESTIMATE_MESSAGE: "x" }));
import { feeSwapLeg } from "./swap/leg";
import { JupiterNoRouteError } from "./swap/jupiter";
import { swapFeeRecipientAta } from "./swap/fee";
import { USDC_MINT } from "./ids";
import mainnetMints from "./fixtures/spot-swap-mints-mainnet.json";
import {
  assertSpotSwapAllowlist, buildAndSimulateSpotSwap, quoteSpotSwap, selectSpotSwapToken, spotSwapIssuer, spotSwapMintIssues, spotSwapTokenFor,
  verifySpotSwapSimulation, SpotSwapError, assertSpotSwapPriceImpact, spotSwapRouteCheck, SPOT_SWAP_MAX_PRICE_IMPACT_BPS,
  type SpotSwapAllowlist, type SpotSwapRouteCheck,
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
  { mint: tslaOther.toBase58(), symbol: "TSLAon", underlying: "TSLA", xstocks: false, jupiter: { name: "Tesla Issuer B", tags: ["verified", "stocks"] } },
  { mint: tsla.toBase58(), symbol: "TSLAx", underlying: "TSLA", xstocks: true },
  { mint: nvda.toBase58(), symbol: "NVDAon", underlying: "NVDA", xstocks: false, jupiter: { name: "NVIDIA Issuer B", tags: ["verified"] } },
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

let routeImpact = "0.0003";
function route(amount: bigint) {
  return {
    inputMint: USDC_MINT, outputMint: tsla.toBase58(), inAmount: amount.toString(), outAmount: "522844", otherAmountThreshold: "520230",
    swapMode: "ExactIn", slippageBps: 50, priceImpactPct: routeImpact, platformFee: { amount: "523", feeBps: 10 },
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
  vi.clearAllMocks(); accounts.clear(); slot = 100; feeMovesDuringSimulation = 0; feeBalance = 7_000n; routeImpact = "0.0003";
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
  const unverified = key(), nameless = key(), third = key();
  const list: SpotSwapAllowlist = [
    { mint: unverified.toBase58(), symbol: "TSLAu", underlying: "TSLA", xstocks: false, jupiter: { name: "Unverified Tesla", tags: ["stocks"] } },
    { mint: nameless.toBase58(), symbol: "TSLAn", underlying: "TSLA", xstocks: false, jupiter: { name: "  ", tags: ["verified"] } },
    { mint: tslaOther.toBase58(), symbol: "TSLAon", underlying: "TSLA", xstocks: false, jupiter: { name: "Tesla Issuer B", tags: ["verified", "stocks"] } },
    { mint: third.toBase58(), symbol: "TSLAz", underlying: "TSLA", xstocks: false, jupiter: { name: "Tesla Issuer C", tags: ["verified"] } },
    { mint: tsla.toBase58(), symbol: "TSLAx", underlying: "TSLA", xstocks: true },
  ];
  it("prefers the xStocks token when it has a route, even when listed last", async () => {
    const hasRoute = vi.fn(async (): Promise<SpotSwapRouteCheck> => "ok");
    const selection = await selectSpotSwapToken(list, "tsla", { checkRoute: hasRoute });
    expect(selection).toMatchObject({ status: "selected", mint: tsla.toBase58(), issuerName: "xStocks", xstocks: true, skipped: [] });
    expect(selection.status === "selected" && selection.mintShort).toMatch(/^.{4}….{2}$/);
    expect(hasRoute).toHaveBeenCalledTimes(1);
  });
  it("falls back to the next verified issuer when xStocks has no route", async () => {
    const hasRoute = vi.fn(async (m: string): Promise<SpotSwapRouteCheck> => m === tsla.toBase58() ? "no_route" : "ok");
    const selection = await selectSpotSwapToken(list, "TSLA", { checkRoute: hasRoute });
    expect(selection).toMatchObject({ status: "selected", mint: tslaOther.toBase58(), issuerName: "Tesla Issuer B", xstocks: false });
    expect(selection.skipped.map((s) => [s.mint, s.reason])).toEqual([
      [tsla.toBase58(), "no_route"], [unverified.toBase58(), "unverified"], [nameless.toBase58(), "no_name"],
    ]);
    // Ineligible tokens are never probed (Jupiter free tier).
    expect(hasRoute.mock.calls.map(([m]) => m)).toEqual([tsla.toBase58(), tslaOther.toBase58()]);
  });
  it("skips unverified issuers and verified issuers without a name", async () => {
    const only = list.slice(0, 2);
    const hasRoute = vi.fn(async (): Promise<SpotSwapRouteCheck> => "ok");
    const selection = await selectSpotSwapToken(only, "TSLA", { checkRoute: hasRoute });
    expect(selection).toEqual({ status: "no_route", underlying: "TSLA", skipped: [
      { mint: unverified.toBase58(), mintShort: expect.any(String), reason: "unverified" },
      { mint: nameless.toBase58(), mintShort: expect.any(String), reason: "no_name" },
    ] });
    expect(hasRoute).not.toHaveBeenCalled();
    expect(spotSwapIssuer({ ...only[0]!, jupiter: undefined })).toEqual({ reason: "unverified" });
    expect(spotSwapIssuer({ ...only[1]!, jupiter: { tags: ["verified"] } })).toEqual({ reason: "no_name" });
  });
  it("returns a no-route result (not an error) when nothing is routable", async () => {
    const selection = await selectSpotSwapToken(list, "TSLA", { checkRoute: async () => "no_route" });
    expect(selection.status).toBe("no_route");
    expect(selection.skipped.filter((s) => s.reason === "no_route").map((s) => s.mint)).toEqual([tsla.toBase58(), tslaOther.toBase58(), third.toBase58()]);
    expect(await selectSpotSwapToken(list, "AAPL", { checkRoute: async () => "ok" })).toEqual({ status: "no_route", underlying: "AAPL", skipped: [] });
  });
  it("still throws when the route probe itself fails (outage is not 'no route')", async () => {
    await expect(selectSpotSwapToken(list, "TSLA", { checkRoute: async () => { throw new Error("Jupiter 429"); } })).rejects.toThrow("Jupiter 429");
  });
  it("refuses to build or quote an ineligible issuer token", () => {
    expect(() => spotSwapTokenFor(list, unverified.toBase58())).toThrow(expect.objectContaining({ code: "spot_swap_token_not_allowed", detail: { reason: "unverified" } }));
    expect(() => spotSwapTokenFor(list, nameless.toBase58())).toThrow(expect.objectContaining({ detail: { reason: "no_name" } }));
    expect(spotSwapTokenFor(list, tslaOther.toBase58()).issuerName).toBe("Tesla Issuer B");
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
      operation: "spot-swap", outputMint: tsla.toBase58(), outputMintShort: expect.stringMatching(/^.{4}….{2}$/), outputSymbol: "TSLAx", issuerName: "xStocks", xstocks: true,
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

// PM data, 2026-11-04 (sofi_home_v2/data/jupiter_route_check.json). Jupiter
// priceImpactPct is a fraction: "0.0062" = 0.62%.
const ONDO = {
  TSLAon100: "0.0061505463635080278887952126", // 0.62%: ok
  TSLAon1000: "0.3255911454201397510204206334", // 32.6%: refused
  MSTRon100: "0.9359201969087175779707873446", // 93.6%: refused
  SLVon100: "0.0171336121852215936126448778", // 1.71%: refused
};

describe("1% price-impact cap", () => {
  it("allows up to 1% and refuses above it, with a plain reason", () => {
    expect(SPOT_SWAP_MAX_PRICE_IMPACT_BPS).toBe(100);
    for (const ok of ["0", "0.0099", "0.01", ONDO.TSLAon100]) expect(() => assertSpotSwapPriceImpact(ok)).not.toThrow();
    for (const bad of ["0.0101", ONDO.TSLAon1000, ONDO.MSTRon100, ONDO.SLVon100]) {
      expect(() => assertSpotSwapPriceImpact(bad)).toThrow(expect.objectContaining({ code: "spot_swap_price_impact", message: expect.stringMatching(/liquidity.*1%.*smaller amount/) }));
    }
  });
  it("fails closed when Jupiter reports no or an invalid price impact", () => {
    for (const bad of [undefined, null, "", "NaN", "-0.001", "abc"]) {
      expect(() => assertSpotSwapPriceImpact(bad)).toThrow(expect.objectContaining({ code: "spot_swap_price_impact" }));
    }
  });
  it("refuses to build or quote above 1%, and allows 0.99%", async () => {
    routeImpact = "0.0101";
    expect(await code(build())).toBe("spot_swap_price_impact");
    expect(await code(quoteSpotSwap(tsla.toBase58(), "2", { allowlist, connection }))).toBe("spot_swap_price_impact");
    expect(connection.simulateTransaction).not.toHaveBeenCalled();
    routeImpact = "0.0099";
    expect((await build()).summary.priceImpactPct).toBe("0.0099");
    expect((await quoteSpotSwap(tsla.toBase58(), "2", { allowlist, connection })).priceImpactPct).toBe("0.0099");
  });
  it("route check reports price_impact and no_route for the requested amount", async () => {
    routeImpact = ONDO.TSLAon1000;
    expect(await spotSwapRouteCheck(tsla.toBase58(), 1_000_000_000n)).toBe("price_impact");
    expect(vi.mocked(feeSwapLeg)).toHaveBeenLastCalledWith(expect.objectContaining({ spend: 1_000_000_000n, build: false, inputFee: true }));
    routeImpact = ONDO.TSLAon100;
    expect(await spotSwapRouteCheck(tsla.toBase58(), 100_000_000n)).toBe("ok");
    vi.mocked(feeSwapLeg).mockRejectedValueOnce(new JupiterNoRouteError());
    expect(await spotSwapRouteCheck(tsla.toBase58())).toBe("no_route");
    vi.mocked(feeSwapLeg).mockRejectedValueOnce(new Error("Jupiter 503"));
    await expect(spotSwapRouteCheck(tsla.toBase58())).rejects.toThrow("Jupiter 503");
  });
  it("issuer fallback treats an issuer above 1% for the amount as not routable", async () => {
    const mstrX = key(), mstrOn = key(), mstrB = key();
    const list: SpotSwapAllowlist = [
      { mint: mstrX.toBase58(), symbol: "MSTRx", underlying: "MSTR", xstocks: true },
      { mint: mstrOn.toBase58(), symbol: "MSTRon", underlying: "MSTR", xstocks: false, jupiter: { name: "MicroStrategy (Ondo Tokenized)", tags: ["verified"] } },
      { mint: mstrB.toBase58(), symbol: "MSTR", underlying: "MSTR", xstocks: false, jupiter: { name: "MicroStrategy - Backpack Securities", tags: ["verified"] } },
    ];
    const impacts = new Map([[mstrX.toBase58(), "no_route"], [mstrOn.toBase58(), ONDO.MSTRon100], [mstrB.toBase58(), "0.0099"]]);
    const checkRoute = vi.fn<(mint: string, amount: bigint) => Promise<SpotSwapRouteCheck>>(async (mint) => {
      const value = impacts.get(mint)!;
      if (value === "no_route") return "no_route";
      try { assertSpotSwapPriceImpact(value); return "ok"; } catch { return "price_impact"; }
    });
    const selection = await selectSpotSwapToken(list, "MSTR", { usdcRaw: 100_000_000n, checkRoute });
    expect(selection).toMatchObject({ status: "selected", mint: mstrB.toBase58(), issuerName: "MicroStrategy - Backpack Securities" });
    expect(selection.skipped.map((s) => s.reason)).toEqual(["no_route", "price_impact"]);
    expect(checkRoute.mock.calls.every(([, amount]) => amount === 100_000_000n)).toBe(true);
    impacts.set(mstrB.toBase58(), "0.0101");
    expect(await selectSpotSwapToken(list, "MSTR", { usdcRaw: 100_000_000n, checkRoute })).toMatchObject({ status: "no_route" });
  });
});

describe("real mainnet stock-token mints (fixtures/spot-swap-mints-mainnet.json)", () => {
  const issuesFor = (symbol: string, issuer?: string) => {
    const m = mainnetMints.mints.find((item) => item.symbol === symbol && (!issuer || item.issuer === issuer))!;
    return spotSwapMintIssues(new PublicKey(m.mint), info(Buffer.from(m.data, "base64"), new PublicKey(m.owner))).issues;
  };
  it("refuses exactly the five tokens whose ScaledUiAmount multiplier is not 1", () => {
    const refused = mainnetMints.mints.filter((m) => issuesFor(m.symbol, m.issuer).length).map((m) => `${m.issuer} ${m.symbol}`);
    expect(refused).toEqual(["xStocks NVDAx", "xStocks SPYx", "Backpack MU", "Ondo NVDAon", "Ondo SPYon"]);
    for (const name of refused) expect(issuesFor(name.split(" ")[1]!, name.split(" ")[0])).toEqual(["ScaledUiAmount multiplier not 1"]);
  });
  it("accepts permanent delegate and confidential transfer (every xStocks and Backpack token has them)", () => {
    for (const m of mainnetMints.mints.filter((item) => item.issuer !== "Ondo")) {
      const mintInfo = info(Buffer.from(m.data, "base64"), new PublicKey(m.owner));
      const types = getExtensionTypes(unpackMint(new PublicKey(m.mint), mintInfo, mintInfo.owner).tlvData);
      expect(types).toEqual(expect.arrayContaining([ExtensionType.PermanentDelegate, ExtensionType.ConfidentialTransferMint]));
    }
    for (const symbol of ["TSLAx", "SPCXx", "MSTRx", "SPCX", "TSLA", "TTWO", "SKHY", "TSLAon", "SLVon", "MSTRon"]) expect(issuesFor(symbol)).toEqual([]);
  });
  it("accepts synthetic permanent-delegate and confidential-transfer mints", () => {
    const pd = extendedMint(ExtensionType.PermanentDelegate, (p) => key().toBuffer().copy(p));
    const ct = extendedMint(ExtensionType.ConfidentialTransferMint, (p) => key().toBuffer().copy(p));
    expect(spotSwapMintIssues(tsla, info(pd, TOKEN_2022_PROGRAM_ID)).issues).toEqual([]);
    expect(spotSwapMintIssues(tsla, info(ct, TOKEN_2022_PROGRAM_ID)).issues).toEqual([]);
  });
});
