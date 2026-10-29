import { type Address, encodeFunctionData, getAddress, type Hex, isAddressEqual, type PublicClient, recoverTypedDataAddress } from "viem";
import { UNIV4_RHC, type Univ4AllowlistedPool } from "./constants";
import { ERC20_OPEN_ABI, PERMIT2_ABI } from "./open-abi";
import { analyseOpenLogs, type OpenContext, type OpenSimAnalysis, quoterFor, readOpenContext, type RpcStateOverrides, simulateCalls, toViemStateOverride } from "./open-chain";
import {
  GAS_BUFFER_BPS, LEFTOVER_REFUND_TEMPLATE, MAX_REQUOTE_RETRIES, MAX_UINT256, PINNED_UNIVERSAL_ROUTER, REQUOTE_CONFIRM_MESSAGE,
} from "./open-constants";
import { FEE_WALLET_UNCONFIGURED_MESSAGE, parseRhcFeeRecipient } from "./fee-recipient";
import { assertOpenRange, type OpenAmounts, OpenPlanError, planOpenAmounts, type QuoteFn } from "./open-quote";
import { buildOpenExecute, buildPermitSingle, type OpenTxRequest, type PermitSingle, permitTypedData } from "./tx-open-ur";
import { checkOpenPlan, PlanGuardError } from "./plan-guard";

/**
 * Server-side open flow (design §3.5 / §3.10, PM decisions 2026-10-29). Two steps, no signing or broadcast here:
 *  1. `prepareOpen`: re-read state, plan, build the pre-sign variant, simulate it (eth_simulateV1, Permit2.approve
 *     stands in for the signature) and return the Permit2 typed data for the wallet → `needs_signature`.
 *  2. `finalizeOpen`: with the user's Permit2 signature, re-quote at the last moment, build the real `execute`,
 *     check it, simulate it and estimate gas (+25%) → `ready`. After an on-chain revert the client calls it again
 *     with `attempt: 1`: one automatic re-quote with the SAME signature → `confirm_again` (PM wording). A second
 *     revert → `failed`.
 */

export type OpenRequest = {
  pool: Univ4AllowlistedPool;
  user: Address;
  depositToken: Address;
  amount: bigint;
  tickLower: number;
  tickUpper: number;
};

export type OpenFailureCode =
  | OpenPlanError["code"] | PlanGuardError["code"] | "pool-delisted" | "deposit-token" | "insufficient-balance" | "simulation-reverted"
  | "simulation-check" | "permit-mismatch" | "signature-invalid" | "retry-budget" | "rpc" | "fee-wallet-unconfigured";

export type OpenPlanView = {
  kind: OpenAmounts["kind"];
  depositToken: Address;
  amountIn: string;
  swapIn: string;
  quoteOut: string;
  minOut: string;
  fee: string;
  liquidity: string;
  amount0Max: string;
  amount1Max: string;
  priceTolBps: number;
  slippageBps: number;
  ticksCrossed: number[];
  iterations: number;
  sqrtPriceBeforeX96: string;
  sqrtPriceAfterX96: string;
  blockNumber: string;
  /** TAKE_PORTION recipient: the configured EVM fee wallet (`RHC_UNIV4_FEE_WALLET`). */
  feeRecipient: Address;
};

/** Refunded share of the deposit (both tokens, valued in the deposit token at the post-swap price). */
export type LeftoverView = { pctOfDeposit: number; display: string; refund0: string; refund1: string; message: { zh: string; en: string } };

export type SimulationView = { status: "success" | "reverted"; gasUsed: string; revert: string | null; checks: Record<keyof OpenSimAnalysis, string | boolean | string[] | null> | null };

export type TxView = { from: Address; to: Address; data: Hex; value: "0x0"; gasLimit?: string; chainId: 4663 };

export type OpenFlowResult =
  | { state: "needs_signature"; plan: OpenPlanView; leftover: LeftoverView; typedData: ReturnType<typeof permitTypedDataJson>; permit: PermitJson; approvalTx: TxView | null; simulation: SimulationView }
  | { state: "ready" | "confirm_again"; attempt: number; plan: OpenPlanView; leftover: LeftoverView; tx: TxView; gas: { estimate: string; limit: string }; simulation: SimulationView;
      message?: typeof REQUOTE_CONFIRM_MESSAGE }
  | { state: "failed"; code: OpenFailureCode; message: string; attempt?: number };

export type PermitJson = { details: { token: Address; amount: string; expiration: number; nonce: number }; spender: Address; sigDeadline: string };

export type OpenFlowDeps = {
  client: PublicClient;
  /** Injected for tests; defaults to the on-chain V4Quoter via `client`. */
  quote?: QuoteFn;
  /** Offline captures / tests only (balances for a throwaway account). Never set from a request. */
  stateOverrides?: RpcStateOverrides;
  /**
   * EVM fee wallet from the host's server-only `RHC_UNIV4_FEE_WALLET`. Fail closed: missing or not an EIP-55
   * checksummed address → `fee-wallet-unconfigured`, before any RPC call, and nothing is built.
   */
  feeRecipient: string | null | undefined;
};

export const RETRY_FAILED_MESSAGE = {
  zh: "價格變動太快，請稍後再試或把區間設寬一點",
  en: "The price is moving too fast. Please try again later or use a wider range.",
} as const;

const failed = (code: OpenFailureCode, message: string, attempt?: number): OpenFlowResult => ({ state: "failed", code, message, ...(attempt === undefined ? {} : { attempt }) });

function permitJson(p: PermitSingle): PermitJson {
  return { details: { ...p.details, amount: p.details.amount.toString() }, spender: p.spender, sigDeadline: p.sigDeadline.toString() };
}
export function permitFromJson(p: PermitJson): PermitSingle {
  return { details: { token: getAddress(p.details.token), amount: BigInt(p.details.amount), expiration: Number(p.details.expiration), nonce: Number(p.details.nonce) },
    spender: getAddress(p.spender), sigDeadline: BigInt(p.sigDeadline) };
}
/**
 * JSON for the wallet's `eth_signTypedData_v4`. Wallets (MetaMask / eth-sig-util) hash the domain with the
 * `EIP712Domain` type from `types`; if it is missing they hash an empty domain and the signature recovers to a
 * different address. viem adds it implicitly on the server, so it must be explicit here.
 */
export const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
] as const;
export function permitTypedDataJson(p: PermitSingle) {
  const t = permitTypedData(p);
  return { ...t, types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...t.types }, message: permitJson(p) };
}

function planView(req: OpenRequest, ctx: OpenContext, a: OpenAmounts, feeRecipient: Address): OpenPlanView {
  return {
    kind: a.kind, depositToken: req.depositToken, amountIn: a.amountIn.toString(), swapIn: a.swapIn.toString(), quoteOut: a.quoteOut.toString(),
    minOut: a.minOut.toString(), fee: a.fee.toString(), liquidity: a.liquidity.toString(), amount0Max: a.amount0Max.toString(), amount1Max: a.amount1Max.toString(),
    priceTolBps: a.priceTolBps, slippageBps: Number(a.slippageBps), ticksCrossed: a.ticksCrossed, iterations: a.iterations,
    sqrtPriceBeforeX96: ctx.state.sqrtPriceX96.toString(), sqrtPriceAfterX96: a.sqrtPriceAfterX96.toString(), blockNumber: ctx.blockNumber.toString(),
    feeRecipient,
  };
}

const txView = (tx: OpenTxRequest, gasLimit?: bigint): TxView => ({ from: tx.from, to: tx.to, data: tx.data, value: "0x0", chainId: 4663, ...(gasLimit ? { gasLimit: gasLimit.toString() } : {}) });

function simView(status: "success" | "reverted", gasUsed: bigint, revert: string | null, analysis: OpenSimAnalysis | null): SimulationView {
  const checks = analysis && Object.fromEntries(Object.entries(analysis).map(([k, v]) =>
    [k, typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(String) : v as string | boolean | null])) as SimulationView["checks"];
  return { status, gasUsed: gasUsed.toString(), revert, checks };
}

const Q192 = 1n << 192n;

/** "<0.01", "0.37", "2.4" — the X in the leftover note. */
export function formatLeftoverPct(pct: number): string {
  if (!(pct > 0)) return "0";
  if (pct < 0.01) return "<0.01";
  return pct < 1 ? pct.toFixed(2) : pct.toFixed(1);
}

/** Leftover note from the simulated refund transfers (POSM SWEEPs to the user). */
export function leftoverRefund(analysis: Pick<OpenSimAnalysis, "refund0" | "refund1">, amounts: Pick<OpenAmounts, "amountIn" | "sqrtPriceAfterX96">, depositIsToken0: boolean): LeftoverView {
  const sp2 = amounts.sqrtPriceAfterX96 * amounts.sqrtPriceAfterX96;
  const value = sp2 === 0n ? (depositIsToken0 ? analysis.refund0 : analysis.refund1)
    : depositIsToken0 ? analysis.refund0 + analysis.refund1 * Q192 / sp2 : analysis.refund1 + analysis.refund0 * sp2 / Q192;
  const ppm = amounts.amountIn > 0n ? value * 1_000_000n / amounts.amountIn : 0n;
  const pctOfDeposit = Number(ppm) / 10_000;
  const display = formatLeftoverPct(pctOfDeposit);
  return { pctOfDeposit, display, refund0: analysis.refund0.toString(), refund1: analysis.refund1.toString(),
    message: { zh: LEFTOVER_REFUND_TEMPLATE.zh.replace("{x}", display), en: LEFTOVER_REFUND_TEMPLATE.en.replace("{x}", display) } };
}

/** Post-simulation invariants: NFT to the user only, fee exactly floor(10 bps × swap output), never on the deposit token. */
function simulationProblems(a: OpenSimAnalysis, kind: OpenAmounts["kind"]): string | null {
  if (!a.nftToUser) return "position NFT not minted to the user";
  if (a.feeOnDepositToken !== 0n) return "fee charged on the deposit token";
  if (kind === "no-swap" && a.feePaid !== 0n) return "fee charged without a swap";
  if (kind === "swap" && !a.feeExact) return "fee is not floor(10 bps × swap output)";
  return null;
}

type Planned = { ctx: OpenContext; amounts: OpenAmounts; depositIsToken0: boolean };

async function plan(deps: OpenFlowDeps, req: OpenRequest): Promise<Planned | OpenFlowResult> {
  const { pool } = req;
  const depositIsToken0 = isAddressEqual(req.depositToken, pool.currency0.address);
  if (!depositIsToken0 && !isAddressEqual(req.depositToken, pool.currency1.address)) return failed("deposit-token", "Deposit token is not in this pool");
  if (req.amount <= 0n) return failed("amount-invalid", "Deposit amount must be positive");
  // Cheap range checks first (PM: minimum ±10 ticks) so a bad range never costs an RPC call.
  try { assertOpenRange(req.tickLower, req.tickUpper, pool.tickSpacing); } catch (error) {
    if (error instanceof OpenPlanError) return failed(error.code, error.message);
    throw error;
  }
  let ctx: OpenContext;
  try { ctx = await readOpenContext(deps.client, pool, req.user, req.depositToken, deps.stateOverrides); } catch { return failed("rpc", "Could not read Robinhood Chain state"); }
  if (ctx.pool.status !== "listed") return failed("pool-delisted", `Pool is delisted: ${ctx.pool.delistReasons.join(", ")}`);
  if (ctx.routerCodeHash?.toLowerCase() !== PINNED_UNIVERSAL_ROUTER.runtimeCodeHash) return failed("router-codehash", "Universal Router code changed; opening is disabled");
  if (ctx.user.balance < req.amount) return failed("insufficient-balance", "Wallet balance is lower than the deposit amount");
  try {
    const amounts = await planOpenAmounts({ state: ctx.state, quote: deps.quote ?? quoterFor(deps.client, pool), depositIsToken0, amountIn: req.amount,
      tickLower: req.tickLower, tickUpper: req.tickUpper, tickSpacing: pool.tickSpacing });
    return { ctx, amounts, depositIsToken0 };
  } catch (error) {
    if (error instanceof OpenPlanError) return failed(error.code, error.message);
    return failed("rpc", "Quote failed");
  }
}

export async function prepareOpen(deps: OpenFlowDeps, req: OpenRequest): Promise<OpenFlowResult> {
  const feeRecipient = parseRhcFeeRecipient(deps.feeRecipient);
  if (!feeRecipient) return failed("fee-wallet-unconfigured", FEE_WALLET_UNCONFIGURED_MESSAGE);
  const planned = await plan(deps, req);
  if ("state" in planned) return planned;
  const { ctx, amounts, depositIsToken0 } = planned;
  const permit = buildPermitSingle(req.depositToken, req.amount, ctx.user.permit2.nonce, ctx.nowSeconds);
  const tx = buildOpenExecute({ pool: req.pool, user: req.user, depositIsToken0, amounts, tickLower: req.tickLower, tickUpper: req.tickUpper, permit, signature: null, nowSeconds: ctx.nowSeconds, feeRecipient });
  try {
    checkOpenPlan({ tx, pool: req.pool, user: req.user, tokenIn: req.depositToken, nowSeconds: ctx.nowSeconds, presign: true, routerCodeHash: ctx.routerCodeHash, feeRecipient });
  } catch (error) {
    if (error instanceof PlanGuardError) return failed(error.code, error.message);
    throw error;
  }
  const needsApproval = ctx.user.erc20AllowanceToPermit2 < req.amount;
  const approvalTx: OpenTxRequest | null = needsApproval
    ? { from: req.user, to: req.depositToken, data: encodeFunctionData({ abi: ERC20_OPEN_ABI, functionName: "approve", args: [UNIV4_RHC.permit2, MAX_UINT256] }), value: 0n }
    : null;
  // Pre-sign stand-in for PERMIT2_PERMIT: the same allowance via an unsigned Permit2.approve from the user (validation off).
  const permit2Approve = { from: req.user, to: UNIV4_RHC.permit2 as Address,
    data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: "approve", args: [req.depositToken, PINNED_UNIVERSAL_ROUTER.address, req.amount, permit.details.expiration] }) };
  let sim;
  try {
    sim = await simulateCalls(deps.client, [...(approvalTx ? [approvalTx] : []), permit2Approve, tx], deps.stateOverrides);
  } catch { return failed("rpc", "Simulation unavailable"); }
  const last = sim.at(-1)!;
  const view = planView(req, ctx, amounts, feeRecipient);
  if (sim.slice(0, -1).some(s => s.status !== "success")) return failed("simulation-reverted", "Approval step failed in simulation");
  if (last.status !== "success") return failed("simulation-reverted", `Simulation reverted: ${last.revert}`);
  const analysis = analyseOpenLogs(last.logs, req.pool, req.user, depositIsToken0, feeRecipient);
  const problem = simulationProblems(analysis, amounts.kind);
  if (problem) return failed("simulation-check", problem);
  return { state: "needs_signature", plan: view, leftover: leftoverRefund(analysis, amounts, depositIsToken0), typedData: permitTypedDataJson(permit), permit: permitJson(permit),
    approvalTx: approvalTx && txView(approvalTx), simulation: simView("success", last.gasUsed, null, analysis) };
}

export async function finalizeOpen(deps: OpenFlowDeps, req: OpenRequest & { permit: PermitSingle; signature: Hex; attempt: number }): Promise<OpenFlowResult> {
  if (!Number.isInteger(req.attempt) || req.attempt < 0) return failed("retry-budget", "Invalid attempt");
  if (req.attempt > MAX_REQUOTE_RETRIES) return failed("retry-budget", RETRY_FAILED_MESSAGE.en, req.attempt);
  const feeRecipient = parseRhcFeeRecipient(deps.feeRecipient);
  if (!feeRecipient) return failed("fee-wallet-unconfigured", FEE_WALLET_UNCONFIGURED_MESSAGE, req.attempt);
  const p = req.permit;
  if (!isAddressEqual(p.details.token, req.depositToken) || p.details.amount !== req.amount || !isAddressEqual(p.spender, PINNED_UNIVERSAL_ROUTER.address))
    return failed("permit-mismatch", "Permit does not match this deposit");
  let signer: Address;
  try { signer = await recoverTypedDataAddress({ ...permitTypedData(p), signature: req.signature }); } catch { return failed("signature-invalid", "Permit2 signature is invalid"); }
  if (!isAddressEqual(signer, req.user)) return failed("signature-invalid", "Permit2 signature is not from this wallet");
  const planned = await plan(deps, req);
  if ("state" in planned) return { ...planned, attempt: req.attempt } as OpenFlowResult;
  const { ctx, amounts, depositIsToken0 } = planned;
  if (BigInt(ctx.nowSeconds) >= p.sigDeadline || ctx.nowSeconds >= p.details.expiration) return failed("permit-mismatch", "Permit2 signature expired; please sign again", req.attempt);
  if (ctx.user.permit2.nonce !== p.details.nonce) return failed("permit-mismatch", "Permit2 nonce changed; please sign again", req.attempt);
  if (ctx.user.erc20AllowanceToPermit2 < req.amount) return failed("permit-mismatch", "Approve Permit2 for this token first", req.attempt);
  const tx = buildOpenExecute({ pool: req.pool, user: req.user, depositIsToken0, amounts, tickLower: req.tickLower, tickUpper: req.tickUpper, permit: p, signature: req.signature, nowSeconds: ctx.nowSeconds, feeRecipient });
  try {
    checkOpenPlan({ tx, pool: req.pool, user: req.user, tokenIn: req.depositToken, nowSeconds: ctx.nowSeconds, routerCodeHash: ctx.routerCodeHash, feeRecipient });
  } catch (error) {
    if (error instanceof PlanGuardError) return failed(error.code, error.message, req.attempt);
    throw error;
  }
  let sim, estimate: bigint;
  try {
    [sim] = await simulateCalls(deps.client, [tx], deps.stateOverrides);
  } catch { return failed("rpc", "Simulation unavailable", req.attempt); }
  if (sim!.status !== "success") return failed("simulation-reverted", `Simulation reverted: ${sim!.revert}`, req.attempt);
  const analysis = analyseOpenLogs(sim!.logs, req.pool, req.user, depositIsToken0, feeRecipient);
  const problem = simulationProblems(analysis, amounts.kind);
  if (problem) return failed("simulation-check", problem, req.attempt);
  try {
    estimate = await deps.client.estimateGas({ account: req.user, to: tx.to, data: tx.data, value: 0n, blockTag: "latest", stateOverride: toViemStateOverride(deps.stateOverrides) });
  } catch { return failed("rpc", "Gas estimate failed", req.attempt); }
  const limit = estimate * (10_000n + GAS_BUFFER_BPS) / 10_000n;
  const base = { attempt: req.attempt, plan: planView(req, ctx, amounts, feeRecipient), leftover: leftoverRefund(analysis, amounts, depositIsToken0), tx: txView(tx, limit), gas: { estimate: estimate.toString(), limit: limit.toString() },
    simulation: simView("success", sim!.gasUsed, null, analysis) };
  return req.attempt === 0 ? { state: "ready", ...base } : { state: "confirm_again", ...base, message: REQUOTE_CONFIRM_MESSAGE };
}
