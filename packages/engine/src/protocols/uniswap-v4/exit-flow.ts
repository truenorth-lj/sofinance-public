import { type Address, getAddress, isAddressEqual, type PublicClient } from "viem";
import { UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS, type Univ4AllowlistedPool } from "./constants";
import { POSITION_MANAGER_READ_ABI, TRANSFER_TOPIC } from "./open-abi";
import { type SimLog, simulateCalls } from "./open-chain";
import { EXIT_SLIPPAGE_BPS, GAS_BUFFER_BPS } from "./open-constants";
import type { TxView } from "./open-flow";
import { buildExitModifyLiquidities, checkExitPlan, ExitGuardError } from "./tx-exit-posm";

/**
 * Server-side exit (close position) flow, PR7 (design §3.8 / §6.2). One step, no signing or broadcast here:
 * re-read the position at `latest` (owner == user, allowlisted pool), simulate the full exit with mins 0 from the owner
 * (eth_simulateV1) to get the exact amounts out, set amount0Min/amount1Min = simulated × (1 − 50 bps), build, check
 * (`checkExitPlan`), simulate again with the mins, estimate gas (+25%) and check the owner can pay for it → `ready`.
 * NO SoFinance fee on exit: the simulation must show the two pool tokens going to the owner only and the NFT burned.
 * A delisted pool can still exit (design §9 risk 1): only the allowlisted pool key is required.
 */

export const MAX_POSITION_LOOKUP = 10;

export type RhcPositionView = {
  tokenId: string;
  owner: Address;
  ownedByUser: boolean;
  liquidity: string;
  tickLower: number;
  tickUpper: number;
  /** Allowlisted pool id, or null when the position is in another pool (shown but not closable here). */
  poolId: string | null;
  baseSymbol: string | null;
};

export type ExitFailureCode = "not-found" | "not-owner" | "pool-not-allowlisted" | "insufficient-gas" | "simulation-reverted" | "simulation-check" | "guard" | "rpc";

export type ExitSimView = { gasUsed: string; amount0: string; amount1: string; burned: boolean; otherTransfers: string[] };

export type ExitFlowResult =
  | {
      state: "ready";
      position: RhcPositionView;
      /** Simulated amounts the owner receives (principal + uncollected pool fees), and the enforced minimums. */
      expected: { amount0: string; amount1: string };
      min: { amount0: string; amount1: string };
      slippageBps: number;
      tx: TxView;
      gas: { estimate: string; limit: string; gasPrice: string; maxCostWei: string };
      simulation: ExitSimView;
      blockNumber: string;
      deadline: string;
    }
  | { state: "failed"; code: ExitFailureCode; message: string };

export type ExitFlowDeps = {
  client: PublicClient;
  /** Server-only EVM fee wallet, when configured: asserted to receive nothing on exit. Exit never needs it. */
  feeRecipient?: Address | null;
};

const failed = (code: ExitFailureCode, message: string): ExitFlowResult => ({ state: "failed", code, message });

const int24 = (v: bigint) => { const x = Number(v & 0xffffffn); return x >= 0x800000 ? x - 0x1000000 : x; };

/** PositionInfo (v4-periphery PositionInfoLibrary): | poolId 200 | tickUpper 24 | tickLower 24 | hasSubscriber 8 |. */
export function decodePositionInfo(info: bigint): { tickLower: number; tickUpper: number; hasSubscriber: boolean } {
  return { hasSubscriber: (info & 0xffn) !== 0n, tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n) };
}

type PositionRead = { tokenId: bigint; owner: Address; liquidity: bigint; tickLower: number; tickUpper: number; pool: Univ4AllowlistedPool | null };

function poolFor(key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }): Univ4AllowlistedPool | null {
  return UNIV4_RHC_ALLOWLISTED_POOLS.find(p => isAddressEqual(key.currency0, p.currency0.address) && isAddressEqual(key.currency1, p.currency1.address)
    && key.fee === p.fee && key.tickSpacing === p.tickSpacing && isAddressEqual(key.hooks, p.hooks)) ?? null;
}

/** `null` when the NFT does not exist (never minted or already burned: `ownerOf` reverts). */
export async function readPosition(client: PublicClient, tokenId: bigint): Promise<PositionRead | null> {
  const posm = UNIV4_RHC.positionManager as Address;
  let owner: Address;
  try { owner = await client.readContract({ address: posm, abi: POSITION_MANAGER_READ_ABI, functionName: "ownerOf", args: [tokenId] }); } catch (error) {
    if (isRevert(error)) return null;
    throw error;
  }
  const [liquidity, [key, info]] = await Promise.all([
    client.readContract({ address: posm, abi: POSITION_MANAGER_READ_ABI, functionName: "getPositionLiquidity", args: [tokenId] }),
    client.readContract({ address: posm, abi: POSITION_MANAGER_READ_ABI, functionName: "getPoolAndPositionInfo", args: [tokenId] }),
  ]);
  const { tickLower, tickUpper } = decodePositionInfo(info);
  return { tokenId, owner: getAddress(owner), liquidity, tickLower, tickUpper, pool: poolFor(key) };
}

/** A contract revert (vs. a transport failure): viem wraps it as ContractFunctionRevertedError / execution reverted. */
function isRevert(error: unknown): boolean {
  let e: unknown = error;
  for (let i = 0; i < 8 && e && typeof e === "object"; i++) {
    const name = (e as { name?: string }).name ?? "";
    const message = (e as { message?: string }).message ?? "";
    if (name === "ContractFunctionRevertedError" || /revert|NOT_MINTED|invalid token/i.test(message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

const view = (p: PositionRead, user: Address): RhcPositionView => ({
  tokenId: p.tokenId.toString(), owner: p.owner, ownedByUser: isAddressEqual(p.owner, user), liquidity: p.liquidity.toString(),
  tickLower: p.tickLower, tickUpper: p.tickUpper, poolId: p.pool?.poolId ?? null, baseSymbol: p.pool?.baseSymbol ?? null,
});

export type PositionLookup = { tokenId: string; position: RhcPositionView | null; error?: "not-found" | "rpc" };

/** Read positions by NFT id (v4 POSM is not enumerable and RHC RPC log scans are not viable; the client supplies ids). */
export async function lookupPositions(client: PublicClient, user: Address, tokenIds: bigint[]): Promise<PositionLookup[]> {
  const ids = [...new Set(tokenIds.map(String))].slice(0, MAX_POSITION_LOOKUP).map(BigInt);
  return Promise.all(ids.map(async (id): Promise<PositionLookup> => {
    try {
      const p = await readPosition(client, id);
      return p ? { tokenId: id.toString(), position: view(p, user) } : { tokenId: id.toString(), position: null, error: "not-found" };
    } catch { return { tokenId: id.toString(), position: null, error: "rpc" }; }
  }));
}

const topicAddress = (topic: string | undefined) => `0x${(topic ?? "").slice(-40)}`.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

/** Transfer-log assertions for an exit: only the two pool tokens to the owner, and the NFT burned from the owner. */
export function analyseExitLogs(logs: SimLog[], pool: Univ4AllowlistedPool, user: Address, tokenId: bigint, feeRecipient?: Address | null) {
  const t0 = pool.currency0.address.toLowerCase(), t1 = pool.currency1.address.toLowerCase(), u = user.toLowerCase();
  const posm = UNIV4_RHC.positionManager.toLowerCase(), fee = feeRecipient?.toLowerCase();
  let amount0 = 0n, amount1 = 0n, burned = false, feeWalletTouched = false;
  const other: string[] = [];
  for (const l of logs) {
    if (l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const a = l.address.toLowerCase(), from = topicAddress(l.topics[1]), to = topicAddress(l.topics[2]);
    if (fee && (to === fee || from === fee)) feeWalletTouched = true;
    if (a === posm && l.topics.length === 4) {
      if (BigInt(l.topics[3]!) === tokenId && from === u && to === ZERO) burned = true; else other.push(`nft ${from}->${to}`);
      continue;
    }
    const amount = l.data && l.data !== "0x" ? BigInt(l.data) : 0n;
    if (to === u && a === t0) amount0 += amount;
    else if (to === u && a === t1) amount1 += amount;
    else other.push(`${a} ${from}->${to} ${amount}`);
  }
  return { amount0, amount1, burned, feeWalletTouched, other };
}

function simProblem(a: ReturnType<typeof analyseExitLogs>): string | null {
  if (a.feeWalletTouched) return "No fee on exit, but the simulation sent tokens to the fee wallet";
  if (!a.burned) return "The simulation did not close (burn) the position";
  if (a.other.length) return `Unexpected transfers in the simulation: ${a.other.join("; ")}`;
  return null;
}

const fmtEth = (wei: bigint) => {
  const s = (Number(wei) / 1e18).toPrecision(2);
  return Number(s).toString();
};

export const INSUFFICIENT_GAS_MESSAGE = (needWei: bigint, haveWei: bigint) =>
  `Not enough ETH on Robinhood Chain to pay the gas for closing (need about ${fmtEth(needWei)} ETH, wallet has ${fmtEth(haveWei)} ETH). Add some ETH, then try again.`;

const revertMessage = (revert: string | null) => {
  if (revert === "NotApproved") return "This wallet is not allowed to close this position (it is not the owner).";
  if (revert === "MinimumAmountInsufficient") return "The price moved while closing. Preview again to get fresh amounts.";
  if (revert === "DeadlinePassed") return "The close transaction expired. Preview again.";
  return `Closing would fail on Robinhood Chain right now (${revert ?? "unknown reason"}). Nothing was sent.`;
};

export async function prepareExit(deps: ExitFlowDeps, req: { user: Address; tokenId: bigint }): Promise<ExitFlowResult> {
  const { client } = deps;
  const user = getAddress(req.user);
  let pos: PositionRead | null, block: { number: bigint | null; timestamp: bigint };
  try {
    [pos, block] = await Promise.all([readPosition(client, req.tokenId), client.getBlock({ blockTag: "latest" })]);
  } catch { return failed("rpc", "Could not read Robinhood Chain right now. Please try again in a moment."); }
  if (!pos) return failed("not-found", `Position #${req.tokenId} does not exist or is already closed.`);
  if (!isAddressEqual(pos.owner, user)) return failed("not-owner", `Position #${req.tokenId} belongs to another wallet (${pos.owner.slice(0, 6)}…${pos.owner.slice(-4)}), not the connected one.`);
  const pool = pos.pool;
  if (!pool) return failed("pool-not-allowlisted", `Position #${req.tokenId} is not in a pool SoFinance supports (only SPCX / SPCXon).`);
  const nowSeconds = Number(block.timestamp);
  const posm = UNIV4_RHC.positionManager as Address;

  const sim0Tx = buildExitModifyLiquidities({ pool, user, tokenId: req.tokenId, liquidity: pos.liquidity, amount0Min: 0n, amount1Min: 0n, nowSeconds });
  let sim0;
  try { [sim0] = await simulateCalls(client, [{ from: user, to: posm, data: sim0Tx.data }]); } catch { return failed("rpc", "Simulation is unavailable right now. Please try again in a moment."); }
  if (sim0!.status !== "success") return failed("simulation-reverted", revertMessage(sim0!.revert));
  const a0 = analyseExitLogs(sim0!.logs, pool, user, req.tokenId, deps.feeRecipient);
  const p0 = simProblem(a0);
  if (p0) return failed("simulation-check", p0);

  const amount0Min = a0.amount0 * (10_000n - EXIT_SLIPPAGE_BPS) / 10_000n;
  const amount1Min = a0.amount1 * (10_000n - EXIT_SLIPPAGE_BPS) / 10_000n;
  const tx = buildExitModifyLiquidities({ pool, user, tokenId: req.tokenId, liquidity: pos.liquidity, amount0Min, amount1Min, nowSeconds });
  try {
    checkExitPlan({ tx, pool, user, tokenId: req.tokenId, nowSeconds, feeRecipient: deps.feeRecipient ?? null });
  } catch (error) {
    if (error instanceof ExitGuardError) return failed("guard", error.message);
    throw error;
  }
  let sim1, estimate: bigint, gasPrice: bigint, balance: bigint;
  try { [sim1] = await simulateCalls(client, [{ from: user, to: posm, data: tx.data }]); } catch { return failed("rpc", "Simulation is unavailable right now. Please try again in a moment."); }
  if (sim1!.status !== "success") return failed("simulation-reverted", revertMessage(sim1!.revert));
  const a1 = analyseExitLogs(sim1!.logs, pool, user, req.tokenId, deps.feeRecipient);
  const p1 = simProblem(a1);
  if (p1) return failed("simulation-check", p1);
  try {
    [gasPrice, balance] = await Promise.all([client.getGasPrice(), client.getBalance({ address: user, blockTag: "latest" })]);
  } catch { return failed("rpc", "Could not read Robinhood Chain right now. Please try again in a moment."); }
  try {
    estimate = await client.estimateGas({ account: user, to: posm, data: tx.data, value: 0n, blockTag: "latest" });
  } catch (error) {
    if (/insufficient funds/i.test(error instanceof Error ? error.message : "")) return failed("insufficient-gas", INSUFFICIENT_GAS_MESSAGE(sim1!.gasUsed * gasPrice, balance));
    return failed("rpc", "Could not estimate gas right now. Please try again in a moment.");
  }
  const limit = estimate * (10_000n + GAS_BUFFER_BPS) / 10_000n;
  const maxCost = limit * gasPrice;
  if (balance < maxCost) return failed("insufficient-gas", INSUFFICIENT_GAS_MESSAGE(maxCost, balance));
  return {
    state: "ready",
    position: view(pos, user),
    expected: { amount0: a1.amount0.toString(), amount1: a1.amount1.toString() },
    min: { amount0: amount0Min.toString(), amount1: amount1Min.toString() },
    slippageBps: Number(EXIT_SLIPPAGE_BPS),
    tx: { from: user, to: posm, data: tx.data, value: "0x0", chainId: 4663, gasLimit: limit.toString() },
    gas: { estimate: estimate.toString(), limit: limit.toString(), gasPrice: gasPrice.toString(), maxCostWei: maxCost.toString() },
    simulation: { gasUsed: sim1!.gasUsed.toString(), amount0: a1.amount0.toString(), amount1: a1.amount1.toString(), burned: a1.burned, otherTransfers: a1.other },
    blockNumber: (block.number ?? 0n).toString(),
    deadline: tx.deadline.toString(),
  };
}
