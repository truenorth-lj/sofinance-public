// In-app spot buy: USDC -> one allowlisted tokenized-stock mint, in a single
// transaction signed only by the user's wallet. Built like the SOL swap step
// (sol-swap-step.ts): CU limit, (output ATA), Jupiter swap. The 10 bps protocol
// fee is Jupiter's input-mint (USDC) platform fee inside the swap, into the fee
// wallet's pre-created USDC account (feeSwapLeg `inputFee`), exactly as on open.
// There is no direct transfer to the fee wallet.
//
// On top of the shared route checks, the server simulation must show exactly:
// fee account +feeAmount, user USDC -amount, output >= minOut, and only the
// wallet signs. Any mismatch fails closed and nothing is returned to sign.
import {
  createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount, unpackMint,
} from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, type AccountInfo, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { parseTokenAmount } from "./amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "./ids";
import { stampPreparedBlockhash, restampVersionedTransaction } from "./fresh-blockhash";
import { JUPITER_MAX_ACCOUNTS, withJupiterRouteRetries, type JupiterRouteConstraints } from "./jupiter-route-retry";
import { assertOpenTransactionSize, compactAtaInstructions, compileCompactOpenTransaction, openLookupTableReader } from "./open-transaction";
import { defaultRpcConnection, rpcConnection } from "./rpc";
import { estimateFeeForMessage, OPEN_FEE_ESTIMATE_MESSAGE } from "./rpc/fee-estimate";
import { associatedTokenAccountRents } from "./token-account-rent";
import { mintBlockReasons, poolMintIssues } from "./token-safety";
import { validateRouteTables } from "./transaction-helpers";
import { atomicComputeUnitLimitInstruction, measuredComputeUnitLimit } from "./transaction-limits";
import { assertNoDirectFeeWalletInstructions, computeSwapFee, readSwapFeeConfig, swapFeeRecipientAta } from "./swap/fee";
import { rejectUnselectedWalletTokenWrites, swapRouteInstructions, verifyIntermediateAccounts, type IntermediateAccount } from "./swap/instructions";
import { JupiterNoRouteError, type BuildRoute } from "./swap/jupiter";
import { feeSwapLeg } from "./swap/leg";

export const USDC_DECIMALS = 6;
/** Base network fee for one signature; a wallet-added priority fee comes on top. */
export const SPOT_SWAP_BASE_FEE_LAMPORTS = 5_000;
/** SOL the simulated swap may debit beyond the output account rent: Jupiter
 * intermediate-account setup and fee headroom (same allowance as the SOL swap step). */
export const SPOT_SWAP_SOL_HEADROOM_LAMPORTS = 5_000_000n;
/** USDC amount used to probe whether a mint has a Jupiter route (1 USDC). */
export const SPOT_SWAP_ROUTE_PROBE_USDC = 1_000_000n;
/** PM cap: refuse to quote, build or select an issuer when Jupiter's reported
 * price impact is above 1%. Jupiter `priceImpactPct` is a fraction ("0.01" = 1%). */
export const SPOT_SWAP_MAX_PRICE_IMPACT_BPS = 100;
/** Jupiter-layer cap is opened up so the spot-swap check below (stricter) gives
 * the user a clear reason instead of the generic 5% error. */
const JUPITER_LAYER_IMPACT_BPS = 10_000;
const STATE_READ_ATTEMPTS = 3;

/** Jupiter token metadata for one mint, fetched by the caller (server-side,
 * cached, Jupiter token search API). The engine makes no metadata calls. */
export type SpotSwapJupiterMetadata = {
  /** Jupiter token name, e.g. "Tesla (Issuer) Tokenized Stock". */
  name?: string | null;
  /** Jupiter tags, e.g. ["verified", "stocks"]. */
  tags?: readonly string[];
};

/** One buyable token. Built by the caller from the token registry (xStocks list,
 * Jupiter metadata); matched by exact mint, never by symbol. */
export type SpotSwapToken = {
  mint: string;
  symbol: string;
  /** Underlying ticker, upper case (e.g. "TSLA"). */
  underlying: string;
  /** On the Backed xStocks list (preferred issuer, shown as "xStocks"). */
  xstocks: boolean;
  /** Required for non-xStocks tokens: they are eligible only with Jupiter's
   * "verified" tag and a non-empty Jupiter name (shown as the issuer name). */
  jupiter?: SpotSwapJupiterMetadata;
};
export type SpotSwapAllowlist = readonly SpotSwapToken[];

export type SpotSwapErrorCode =
  | "spot_swap_token_not_allowed" | "spot_swap_token_unavailable" | "spot_swap_allowlist_invalid"
  | "spot_swap_fee_not_configured" | "spot_swap_amount_too_small" | "spot_swap_insufficient_usdc"
  | "spot_swap_insufficient_sol" | "spot_swap_fee_mismatch" | "spot_swap_usdc_mismatch"
  | "spot_swap_min_out" | "spot_swap_signer" | "spot_swap_sol_debit" | "spot_swap_state_changed"
  | "spot_swap_simulation_failed" | "spot_swap_price_impact";

export class SpotSwapError extends Error {
  constructor(readonly code: SpotSwapErrorCode, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "SpotSwapError";
  }
}

/** SOL the wallet needs besides the USDC: refundable output-account deposit
 * (only when the wallet has no account for this token yet) + network fee. */
export type SpotSwapSolRequirement = {
  outputAccountExists: boolean;
  /** Refundable when the token account is closed later. 0 when it already exists. */
  outputAccountRentLamports: string;
  networkFeeLamports: string;
  requiredLamports: string;
  walletLamports: string;
  sufficient: boolean;
};

export type SpotSwapSummary = {
  operation: "spot-swap";
  wallet: string;
  inputMint: typeof USDC_MINT;
  outputMint: string;
  outputSymbol: string;
  outputDecimals: number;
  outputProgram: string;
  outputAccount: string;
  issuerName: string;
  outputMintShort: string;
  xstocks: boolean;
  /** USDC raw the wallet spends, fee included. */
  amount: string;
  feeBps: number;
  /** USDC raw charged as protocol fee = floor(amount * feeBps / 10,000). */
  feeAmount: string;
  /** Fee wallet, shortened for display only. */
  feeWalletShort: string;
  quotedOut: string;
  minOut: string;
  priceImpactPct: string | null;
  /** Output-account increase in the server simulation. */
  simulatedOut: string;
  solRequirement: SpotSwapSolRequirement;
  sizeBytes: number;
  unitsConsumed: number;
  blockhash: string;
  lastValidBlockHeight: number;
  simulatedAt: number;
  expiresAt: number;
};

export function shortAddress(address: string): string {
  return address.length > 8 ? `${address.slice(0, 4)}…${address.slice(-2)}` : address;
}

function canonicalMint(value: string): string | null {
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value ? value : null;
  } catch {
    return null;
  }
}

/** Reject malformed lists: non-canonical mints, USDC/SOL, duplicates, two xStocks for one stock. */
export function assertSpotSwapAllowlist(allowlist: SpotSwapAllowlist): void {
  const mints = new Set<string>();
  const xstocks = new Set<string>();
  for (const token of allowlist) {
    if (!canonicalMint(token.mint) || token.mint === USDC_MINT || token.mint === NATIVE_SOL_MINT) {
      throw new SpotSwapError("spot_swap_allowlist_invalid", `Allowlist contains an invalid mint (${token.symbol})`);
    }
    if (mints.has(token.mint)) throw new SpotSwapError("spot_swap_allowlist_invalid", `Allowlist repeats a mint (${token.symbol})`);
    mints.add(token.mint);
    if (!token.underlying || token.underlying !== token.underlying.toUpperCase()) {
      throw new SpotSwapError("spot_swap_allowlist_invalid", `Allowlist underlying must be upper case (${token.symbol})`);
    }
    if (token.xstocks) {
      if (xstocks.has(token.underlying)) throw new SpotSwapError("spot_swap_allowlist_invalid", `Two xStocks tokens for ${token.underlying}`);
      xstocks.add(token.underlying);
    }
  }
}

/** The allowlisted token for this exact mint, with its issuer name. A look-alike
 * mint (same symbol or name, different address) is refused, and so is a
 * non-xStocks token without Jupiter's "verified" tag and name. */
export function spotSwapTokenFor(allowlist: SpotSwapAllowlist, mint: string): SpotSwapToken & { issuerName: string } {
  assertSpotSwapAllowlist(allowlist);
  const canonical = canonicalMint(mint);
  const token = canonical ? allowlist.find((item) => item.mint === canonical) : undefined;
  if (!token) throw new SpotSwapError("spot_swap_token_not_allowed", "This token is not on the SoFinance stock token list");
  const issuer = spotSwapIssuer(token);
  if ("reason" in issuer) {
    throw new SpotSwapError("spot_swap_token_not_allowed", "This token is not verified for buying", { reason: issuer.reason });
  }
  return { ...token, issuerName: issuer.issuerName };
}

/** Price impact in basis points from Jupiter's fraction, or null when missing/invalid. */
export function spotSwapPriceImpactBps(priceImpactPct: unknown): number | null {
  if (typeof priceImpactPct !== "string" && typeof priceImpactPct !== "number") return null;
  if (typeof priceImpactPct === "string" && !priceImpactPct.trim()) return null;
  const impact = Number(priceImpactPct);
  return Number.isFinite(impact) && impact >= 0 ? impact * 10_000 : null;
}

/** Refuse a route whose reported price impact is above 1% (or not reported). */
export function assertSpotSwapPriceImpact(priceImpactPct: unknown): void {
  const bps = spotSwapPriceImpactBps(priceImpactPct);
  if (bps === null) {
    throw new SpotSwapError("spot_swap_price_impact", "We couldn't confirm a fair price for this amount, so nothing was prepared. Please try again.",
      { priceImpactPct: priceImpactPct ?? null });
  }
  if (bps > SPOT_SWAP_MAX_PRICE_IMPACT_BPS) {
    throw new SpotSwapError("spot_swap_price_impact",
      "There isn't enough trading liquidity to buy this amount without moving the price more than 1%. Try a smaller amount.",
      { priceImpactPct: String(priceImpactPct), maxBps: SPOT_SWAP_MAX_PRICE_IMPACT_BPS });
  }
}

export type SpotSwapRouteCheck = "ok" | "no_route" | "price_impact";

/** Whether Jupiter can fill USDC -> mint for `usdcRaw` with the protocol fee and
 * price impact at most 1%. Other Jupiter failures (outage, rate limit) throw. */
export async function spotSwapRouteCheck(outputMint: string, usdcRaw: bigint = SPOT_SWAP_ROUTE_PROBE_USDC): Promise<SpotSwapRouteCheck> {
  const { bps } = readSwapFeeConfig();
  try {
    const leg = await feeSwapLeg({ wallet: "", inputMint: USDC_MINT, outputMint, spend: usdcRaw, feeBps: bps, inputFee: true, build: false,
      maxPriceImpactBps: JUPITER_LAYER_IMPACT_BPS });
    if (!leg.route) return "no_route";
    assertSpotSwapPriceImpact(leg.route.priceImpactPct);
    return "ok";
  } catch (error) {
    if (error instanceof JupiterNoRouteError) return "no_route";
    if (error instanceof SpotSwapError && error.code === "spot_swap_price_impact") return "price_impact";
    throw error;
  }
}

export type SpotSwapIneligibleReason = "unverified" | "no_name";

/** Issuer name the UI shows next to the short mint: "xStocks" for xStocks tokens;
 * for other issuers the Jupiter name, only when Jupiter tags the token "verified".
 * Otherwise the reason the token is not eligible. */
export function spotSwapIssuer(token: SpotSwapToken): { issuerName: string } | { reason: SpotSwapIneligibleReason } {
  if (token.xstocks) return { issuerName: "xStocks" };
  if (!token.jupiter?.tags?.includes("verified")) return { reason: "unverified" };
  const name = token.jupiter.name?.trim();
  return name ? { issuerName: name } : { reason: "no_name" };
}

export type SpotSwapSkipReason = SpotSwapIneligibleReason | "no_route" | "price_impact";
export type SpotSwapSkipped = { mint: string; mintShort: string; reason: SpotSwapSkipReason };
export type SpotSwapSelection =
  | { status: "selected"; underlying: string; token: SpotSwapToken; mint: string; mintShort: string;
      issuerName: string; xstocks: boolean; skipped: SpotSwapSkipped[] }
  /** Nothing buyable for this stock (no eligible token, or none with a Jupiter
   * route): the UI shows no Buy button. Not an error. */
  | { status: "no_route"; underlying: string; skipped: SpotSwapSkipped[] };

/**
 * Which issuer's token a stock row buys (PM rule): the xStocks token when it has a
 * Jupiter route; otherwise the next eligible issuer token (list order) with a
 * route. "Has a route" means Jupiter fills `usdcRaw` (the amount the user wants;
 * default 1 USDC) with price impact at most 1%; a quote above 1% is skipped as
 * "price_impact". Non-xStocks tokens need Jupiter's "verified" tag and a Jupiter name,
 * and are skipped without a route probe otherwise.
 *
 * "No route" is returned as `{ status: "no_route" }`, not thrown: it is an expected
 * UI state (no Buy button). Quote/build keep the existing pattern of throwing
 * `JupiterNoRouteError`. Other probe failures (Jupiter down, rate limit) still throw,
 * so an outage is not mistaken for "not buyable". Probes run one at a time and stop
 * at the first route (Jupiter free tier).
 */
export async function selectSpotSwapToken(allowlist: SpotSwapAllowlist, underlying: string,
  options: { usdcRaw?: bigint; checkRoute?: (mint: string, usdcRaw: bigint) => Promise<SpotSwapRouteCheck> } = {}): Promise<SpotSwapSelection> {
  const usdcRaw = options.usdcRaw ?? SPOT_SWAP_ROUTE_PROBE_USDC;
  const checkRoute = options.checkRoute ?? spotSwapRouteCheck;
  assertSpotSwapAllowlist(allowlist);
  const ticker = underlying.toUpperCase();
  const candidates = allowlist.filter((token) => token.underlying === ticker);
  const ordered = [...candidates.filter((token) => token.xstocks), ...candidates.filter((token) => !token.xstocks)];
  const skipped: SpotSwapSkipped[] = [];
  for (const token of ordered) {
    const mintShort = shortAddress(token.mint);
    const issuer = spotSwapIssuer(token);
    if ("reason" in issuer) { skipped.push({ mint: token.mint, mintShort, reason: issuer.reason }); continue; }
    const route = await checkRoute(token.mint, usdcRaw);
    if (route !== "ok") { skipped.push({ mint: token.mint, mintShort, reason: route }); continue; }
    return { status: "selected", underlying: ticker, token, mint: token.mint, mintShort, issuerName: issuer.issuerName, xstocks: token.xstocks, skipped };
  }
  return { status: "no_route", underlying: ticker, skipped };
}

/** Why this mint cannot be bought now (empty = ok). Same Token-2022 rules as open:
 * paused, transfer fee, default-frozen, active hook, ScaledUiAmount multiplier not 1,
 * unsupported extensions. */
export function spotSwapMintIssues(mintAddress: PublicKey, info: AccountInfo<Buffer> | null): { program: PublicKey; decimals: number; issues: string[] } {
  if (!info || !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) {
    throw new SpotSwapError("spot_swap_token_unavailable", "Token mint does not exist or is not an SPL / Token-2022 mint");
  }
  const mint = unpackMint(mintAddress, info, info.owner);
  const issues = [...new Set([...mintBlockReasons(mint), ...poolMintIssues(mint)])];
  return { program: info.owner, decimals: mint.decimals, issues };
}

type Balances = { slot: number; lamports: bigint; usdc: bigint; output: bigint; fee: bigint };

function tokenBalance(address: PublicKey, info: AccountInfo<Buffer> | null, program: PublicKey, owner: PublicKey, mint: PublicKey,
  required: boolean, label: string): bigint {
  if (!info) {
    if (required) throw new SpotSwapError("spot_swap_simulation_failed", `${label} account does not exist`);
    return 0n;
  }
  if (!info.owner.equals(program)) throw new SpotSwapError("spot_swap_simulation_failed", `${label} account program mismatch`);
  const account = unpackAccount(address, info, program);
  if (!account.owner.equals(owner) || !account.mint.equals(mint)) throw new SpotSwapError("spot_swap_simulation_failed", `${label} account owner or mint mismatch`);
  if (!account.isInitialized || account.isFrozen) throw new SpotSwapError("spot_swap_simulation_failed", `${label} account is frozen or uninitialized`);
  return account.amount;
}

type SimAccount = { data: string[]; owner: string; lamports: number; executable: boolean; rentEpoch?: number } | null | undefined;
function simInfo(account: SimAccount): AccountInfo<Buffer> | null {
  if (!account || !account.data?.[0] && account.lamports === 0) return null;
  return { data: Buffer.from(account.data?.[0] ?? "", "base64"), owner: new PublicKey(account.owner), lamports: account.lamports,
    executable: account.executable, rentEpoch: account.rentEpoch ?? 0 };
}

/**
 * Exact post-simulation checks (pure). Throws on the first violation:
 * - fee account increase must equal the quoted fee (USDC raw) exactly;
 * - user USDC decrease must equal the entered amount exactly;
 * - output increase must be at least the route's minimum;
 * - SOL debit must stay within the output-account rent plus headroom.
 */
export function verifySpotSwapSimulation(input: {
  amount: bigint; feeAmount: bigint; minOut: bigint; maxSolDebit: bigint;
  pre: Omit<Balances, "slot">; post: Omit<Balances, "slot">;
}) {
  const { pre, post } = input;
  const feeReceived = post.fee - pre.fee;
  if (feeReceived !== input.feeAmount) {
    throw new SpotSwapError("spot_swap_fee_mismatch", "Simulated protocol fee does not equal the quoted fee",
      { quoted: input.feeAmount.toString(), simulated: feeReceived.toString() });
  }
  const usdcSpent = pre.usdc - post.usdc;
  if (usdcSpent !== input.amount) {
    throw new SpotSwapError("spot_swap_usdc_mismatch", "Simulated USDC spend does not equal the entered amount",
      { entered: input.amount.toString(), simulated: usdcSpent.toString() });
  }
  const received = post.output - pre.output;
  if (received < input.minOut) {
    throw new SpotSwapError("spot_swap_min_out", "Simulated swap delivered less than the minimum output",
      { minOut: input.minOut.toString(), simulated: received.toString() });
  }
  const solDebit = pre.lamports - post.lamports;
  if (solDebit > input.maxSolDebit) {
    throw new SpotSwapError("spot_swap_sol_debit", "Simulated swap debits more SOL than expected", { solDebit: solDebit.toString() });
  }
  return { feeReceived, usdcSpent, received, solDebit };
}

/** Exactly one required signature, and it is the wallet as fee payer. */
export function assertWalletOnlySigner(transaction: VersionedTransaction, wallet: PublicKey) {
  const { header, staticAccountKeys } = transaction.message;
  if (header.numRequiredSignatures !== 1 || !staticAccountKeys[0]?.equals(wallet)) {
    throw new SpotSwapError("spot_swap_signer", "Spot swap must require only the wallet signature");
  }
}

type Context = {
  connection: Connection; wallet: PublicKey; outputMint: PublicKey; outputProgram: PublicKey;
  usdcAta: PublicKey; outputAta: PublicKey; feeAta: PublicKey; feeWallet: PublicKey;
};

async function readBalances(ctx: Context, minContextSlot?: number): Promise<Balances> {
  const { context, value } = await ctx.connection.getMultipleAccountsInfoAndContext(
    [ctx.wallet, ctx.usdcAta, ctx.outputAta, ctx.feeAta], { commitment: "confirmed", ...(minContextSlot ? { minContextSlot } : {}) });
  const usdc = new PublicKey(USDC_MINT);
  return {
    slot: context.slot,
    lamports: BigInt(value[0]?.lamports ?? 0),
    usdc: tokenBalance(ctx.usdcAta, value[1] ?? null, TOKEN_PROGRAM_ID, ctx.wallet, usdc, false, "USDC"),
    output: tokenBalance(ctx.outputAta, value[2] ?? null, ctx.outputProgram, ctx.wallet, ctx.outputMint, false, "Output"),
    fee: tokenBalance(ctx.feeAta, value[3] ?? null, TOKEN_PROGRAM_ID, ctx.feeWallet, usdc, true, "Protocol fee"),
  };
}

const sameBalances = (a: Balances, b: Balances) => a.lamports === b.lamports && a.usdc === b.usdc && a.output === b.output && a.fee === b.fee;

/** Simulate and read the exact pre/post balances. Pre-state is read before and
 * re-read after the simulation; if anything moved in between (e.g. another
 * user's fee landed), the delta is ambiguous, so retry, then fail closed. */
async function simulateWithBalances(ctx: Context, transaction: VersionedTransaction, intermediates: IntermediateAccount[]) {
  const addresses = [ctx.wallet, ctx.usdcAta, ctx.outputAta, ctx.feeAta].map((key) => key.toBase58());
  const extra = intermediates.map((item) => item.address);
  for (let attempt = 0; attempt < STATE_READ_ATTEMPTS; attempt++) {
    const pre = await readBalances(ctx);
    const simulation = await ctx.connection.simulateTransaction(transaction, {
      sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", minContextSlot: pre.slot,
      accounts: { encoding: "base64", addresses: [...addresses, ...extra] },
    });
    if (simulation.value.err) {
      throw new SpotSwapError("spot_swap_simulation_failed", `Spot swap simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }
    const after = await readBalances(ctx, simulation.context.slot);
    if (!sameBalances(pre, after)) continue;
    const accounts = simulation.value.accounts ?? [];
    if (accounts.length !== addresses.length + extra.length) throw new SpotSwapError("spot_swap_simulation_failed", "Simulation did not return account state");
    verifyIntermediateAccounts(intermediates, [...addresses, ...extra], accounts, ctx.wallet);
    const usdc = new PublicKey(USDC_MINT);
    const post = {
      lamports: BigInt(accounts[0]?.lamports ?? 0),
      usdc: tokenBalance(ctx.usdcAta, simInfo(accounts[1]), TOKEN_PROGRAM_ID, ctx.wallet, usdc, false, "USDC"),
      output: tokenBalance(ctx.outputAta, simInfo(accounts[2]), ctx.outputProgram, ctx.wallet, ctx.outputMint, true, "Output"),
      fee: tokenBalance(ctx.feeAta, simInfo(accounts[3]), TOKEN_PROGRAM_ID, ctx.feeWallet, usdc, true, "Protocol fee"),
    };
    return { pre, post, unitsConsumed: simulation.value.unitsConsumed ?? 0 };
  }
  throw new SpotSwapError("spot_swap_state_changed", "Balances changed during the swap check; please try again");
}

/**
 * Build and simulate a USDC -> stock token swap for `wallet`. `usdcAmount` is in
 * whole USDC (e.g. "2.5"); the fee is taken from it. `allowlist` comes from the
 * token registry (caller); `outputMint` must be on it exactly.
 */
export async function buildAndSimulateSpotSwap(walletAddress: string, outputMintAddress: string, usdcAmount: string,
  options: { allowlist: SpotSwapAllowlist; connection?: Connection }): Promise<{ summary: SpotSwapSummary; transaction: VersionedTransaction }> {
  const connection = options.connection ?? rpcConnection();
  const token = spotSwapTokenFor(options.allowlist, outputMintAddress);
  const wallet = new PublicKey(walletAddress);
  const feeConfig = readSwapFeeConfig();
  if (!feeConfig.wallet || feeConfig.bps <= 0) {
    throw new SpotSwapError("spot_swap_fee_not_configured", "Buying is temporarily unavailable because the platform fee settings are incomplete. Nothing was prepared.");
  }
  const amount = parseTokenAmount(usdcAmount, USDC_DECIMALS);
  const feeAmount = computeSwapFee(amount, feeConfig.bps);
  if (amount <= 0n || feeAmount <= 0n) throw new SpotSwapError("spot_swap_amount_too_small", "Amount is too small to buy");

  const outputMint = new PublicKey(token.mint);
  const usdcMint = new PublicKey(USDC_MINT);
  const usdcAta = getAssociatedTokenAddressSync(usdcMint, wallet, false, TOKEN_PROGRAM_ID);
  const [walletInfo, mintInfo] = await connection.getMultipleAccountsInfo([wallet, outputMint], "confirmed");
  const mint = spotSwapMintIssues(outputMint, mintInfo ?? null);
  if (mint.issues.length) {
    throw new SpotSwapError("spot_swap_token_unavailable", "This token cannot be bought right now", { issues: mint.issues });
  }
  const outputAta = getAssociatedTokenAddressSync(outputMint, wallet, false, mint.program);
  const feeAta = swapFeeRecipientAta(feeConfig.wallet, usdcMint, TOKEN_PROGRAM_ID);
  const ctx: Context = { connection, wallet, outputMint, outputProgram: mint.program, usdcAta, outputAta, feeAta, feeWallet: feeConfig.wallet };
  const [usdcInfo, outputInfo] = await connection.getMultipleAccountsInfo([usdcAta, outputAta], "confirmed");
  const usdcBalance = tokenBalance(usdcAta, usdcInfo ?? null, TOKEN_PROGRAM_ID, wallet, usdcMint, false, "USDC");
  if (usdcBalance < amount) throw new SpotSwapError("spot_swap_insufficient_usdc", "Not enough USDC in this wallet");
  tokenBalance(outputAta, outputInfo ?? null, mint.program, wallet, outputMint, false, "Output");
  const outputAccountExists = Boolean(outputInfo);
  const outputRent = outputAccountExists ? 0n : (await associatedTokenAccountRents(connection, [token.mint]))[0]!.rentLamports;
  const walletLamports = BigInt(walletInfo?.lamports ?? 0);
  const requirement = (networkFee: bigint, simulatedDebit = 0n): SpotSwapSolRequirement => {
    const required = (simulatedDebit > outputRent ? simulatedDebit : outputRent) + networkFee;
    return {
      outputAccountExists, outputAccountRentLamports: outputRent.toString(), networkFeeLamports: networkFee.toString(),
      requiredLamports: required.toString(), walletLamports: walletLamports.toString(), sufficient: walletLamports >= required,
    };
  };
  const early = requirement(BigInt(SPOT_SWAP_BASE_FEE_LAMPORTS));
  if (!early.sufficient) {
    throw new SpotSwapError("spot_swap_insufficient_sol", "Not enough SOL for the token account deposit and network fee", early);
  }

  const readTables = openLookupTableReader(connection);
  const built = await withJupiterRouteRetries(async (constraints: JupiterRouteConstraints) => {
    const leg = await feeSwapLeg({
      wallet: walletAddress, inputMint: USDC_MINT, outputMint: token.mint, spend: amount, feeBps: feeConfig.bps,
      native: false, inputFee: true, build: true, constraints, maxPriceImpactBps: JUPITER_LAYER_IMPACT_BPS,
    });
    if (!leg.route || !("swapInstruction" in leg.route)) throw new Error("Spot swap route is missing");
    const route = leg.route as BuildRoute;
    assertSpotSwapPriceImpact(route.priceImpactPct);
    // The fee the route charges is the fee we quote: input mint USDC, floor(amount * bps / 10,000).
    if (!leg.feeInRoute || leg.feeAmount !== feeAmount || BigInt(route.inAmount) !== amount) {
      throw new SpotSwapError("spot_swap_fee_mismatch", "Swap route fee does not match the quoted fee");
    }
    if (!route.swapInstruction.accounts.some((key) => key.pubkey === feeAta.toBase58() && key.isWritable)) {
      throw new SpotSwapError("spot_swap_fee_mismatch", "Jupiter swap does not pay the protocol fee account");
    }
    const routeInstructions = swapRouteInstructions([route], wallet);
    const { accounts: intermediates } = await rejectUnselectedWalletTokenWrites(connection, wallet, routeInstructions, [usdcAta.toBase58(), outputAta.toBase58()]);
    const tables = await readTables(Object.keys(route.addressesByLookupTableAddress || {}).map((key) => new PublicKey(key)));
    validateRouteTables([route], tables);
    const instructions = await compactAtaInstructions(connection, [
      atomicComputeUnitLimitInstruction(),
      createAssociatedTokenAccountIdempotentInstruction(wallet, outputAta, wallet, outputMint, mint.program),
      ...routeInstructions,
    ]);
    assertNoDirectFeeWalletInstructions(instructions, feeConfig.wallet);
    if (instructions.some((ix) => ix.keys.some((key) => key.pubkey.equals(feeConfig.wallet!)))) {
      throw new SpotSwapError("spot_swap_fee_mismatch", "Spot swap must not reference the fee wallet directly");
    }
    const blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const transaction = compileCompactOpenTransaction({ payerKey: wallet, recentBlockhash: blockhash, instructions }, tables).transaction;
    assertOpenTransactionSize(transaction);
    return { leg, route, instructions, intermediates, tables, blockhash, transaction };
  });
  assertWalletOnlySigner(built.transaction, wallet);

  const simulated = await simulateWithBalances(ctx, built.transaction, built.intermediates);
  const checked = verifySpotSwapSimulation({
    amount, feeAmount, minOut: built.leg.minOut, maxSolDebit: outputRent + SPOT_SWAP_SOL_HEADROOM_LAMPORTS,
    pre: simulated.pre, post: simulated.post,
  });

  // Simulated with the 1.4M ceiling; ship the measured limit (same position, same keys).
  const limitIndex = built.instructions.findIndex((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2);
  if (limitIndex < 0) throw new Error("Spot swap is missing its compute-unit limit");
  const sized = built.instructions.map((ix, index) => index === limitIndex
    ? ComputeBudgetProgram.setComputeUnitLimit({ units: measuredComputeUnitLimit(simulated.unitsConsumed) }) : ix);
  const final = compileCompactOpenTransaction({ payerKey: wallet, recentBlockhash: built.blockhash, instructions: sized }, built.tables).transaction;
  const latest = await connection.getLatestBlockhash("confirmed");
  const restamped = restampVersionedTransaction(final, latest.blockhash, built.tables);
  assertWalletOnlySigner(restamped, wallet);
  const sizeBytes = assertOpenTransactionSize(restamped);
  const networkFee = await estimateFeeForMessage(connection, restamped.message, "confirmed", {
    fallback: defaultRpcConnection, emptyError: OPEN_FEE_ESTIMATE_MESSAGE,
  });
  const solRequirement = requirement(BigInt(networkFee), checked.solDebit > 0n ? checked.solDebit : 0n);

  const summary: SpotSwapSummary = {
    operation: "spot-swap", wallet: walletAddress, inputMint: USDC_MINT,
    outputMint: token.mint, outputSymbol: token.symbol, outputDecimals: mint.decimals, outputProgram: mint.program.toBase58(),
    outputAccount: outputAta.toBase58(), issuerName: token.issuerName, outputMintShort: shortAddress(token.mint), xstocks: token.xstocks,
    amount: amount.toString(), feeBps: feeConfig.bps, feeAmount: feeAmount.toString(),
    feeWalletShort: shortAddress(feeConfig.wallet.toBase58()),
    quotedOut: built.route.outAmount, minOut: built.leg.minOut.toString(), priceImpactPct: built.route.priceImpactPct ?? null,
    simulatedOut: checked.received.toString(), solRequirement, sizeBytes, unitsConsumed: simulated.unitsConsumed,
    ...stampPreparedBlockhash(latest),
  };
  return { summary, transaction: restamped };
}

export type SpotSwapQuote = {
  outputMint: string; outputMintShort: string; outputSymbol: string; issuerName: string; xstocks: boolean;
  amount: string; feeBps: number; feeAmount: string; feeWalletShort: string;
  quotedOut: string; minOut: string; priceImpactPct: string | null;
  /** Refundable deposit if the wallet has no account for this token yet. */
  newAccountRentLamports: string; baseNetworkFeeLamports: number;
};

/** Read-only price preview before a wallet is connected: fee, quoted and minimum
 * output, and the SOL the UI should warn about. Builds no transaction. */
export async function quoteSpotSwap(outputMintAddress: string, usdcAmount: string,
  options: { allowlist: SpotSwapAllowlist; connection?: Connection }): Promise<SpotSwapQuote> {
  const connection = options.connection ?? rpcConnection();
  const token = spotSwapTokenFor(options.allowlist, outputMintAddress);
  const feeConfig = readSwapFeeConfig();
  if (!feeConfig.wallet || feeConfig.bps <= 0) {
    throw new SpotSwapError("spot_swap_fee_not_configured", "Buying is temporarily unavailable because the platform fee settings are incomplete.");
  }
  const amount = parseTokenAmount(usdcAmount, USDC_DECIMALS);
  const feeAmount = computeSwapFee(amount, feeConfig.bps);
  if (amount <= 0n || feeAmount <= 0n) throw new SpotSwapError("spot_swap_amount_too_small", "Amount is too small to buy");
  const [mintInfo] = await connection.getMultipleAccountsInfo([new PublicKey(token.mint)], "confirmed");
  const mint = spotSwapMintIssues(new PublicKey(token.mint), mintInfo ?? null);
  if (mint.issues.length) throw new SpotSwapError("spot_swap_token_unavailable", "This token cannot be bought right now", { issues: mint.issues });
  const leg = await feeSwapLeg({
    wallet: "", inputMint: USDC_MINT, outputMint: token.mint, spend: amount, feeBps: feeConfig.bps, inputFee: true, build: false,
    constraints: { maxAccounts: JUPITER_MAX_ACCOUNTS.wide }, maxPriceImpactBps: JUPITER_LAYER_IMPACT_BPS,
  });
  if (!leg.route || leg.feeAmount !== feeAmount) throw new SpotSwapError("spot_swap_fee_mismatch", "Swap quote fee does not match the protocol fee");
  assertSpotSwapPriceImpact(leg.route.priceImpactPct);
  const rent = (await associatedTokenAccountRents(connection, [token.mint]))[0]!.rentLamports;
  return {
    outputMint: token.mint, outputMintShort: shortAddress(token.mint), outputSymbol: token.symbol, issuerName: token.issuerName, xstocks: token.xstocks,
    amount: amount.toString(), feeBps: feeConfig.bps, feeAmount: feeAmount.toString(), feeWalletShort: shortAddress(feeConfig.wallet.toBase58()),
    quotedOut: leg.route.outAmount, minOut: leg.minOut.toString(), priceImpactPct: leg.route.priceImpactPct ?? null,
    newAccountRentLamports: rent.toString(), baseNetworkFeeLamports: SPOT_SWAP_BASE_FEE_LAMPORTS,
  };
}
