import { UNIV4_RHC, type Univ4AllowlistedPool } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { TxView } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
import { checkExitPlan, ExitGuardError } from "@sofinance/engine/protocols/uniswap-v4/tx-exit-posm";
import { encodeFunctionData, parseAbi } from "viem";
import type { Eip1193Provider } from "./eip1193";
import { checkTx, TxGuardError } from "./open-execute";

/**
 * Client-side checks and helpers for closing a Robinhood Chain position (PR7). Last refusal before `eth_sendTransaction`:
 * chain 4663, `to` == pinned PositionManager, `from` == connected wallet, value 0, and the calldata re-decoded with the
 * engine's `checkExitPlan` (only DECREASE_LIQUIDITY → BURN_POSITION → TAKE_PAIR for this NFT, tokens to the owner).
 */

export function checkExitTx(tx: TxView, user: string, tokenId: string, pool: Univ4AllowlistedPool): void {
  checkTx(tx, user, UNIV4_RHC.positionManager, "Close transaction");
  try { checkExitPlan({ tx, pool, user, tokenId: BigInt(tokenId) }); } catch (error) {
    if (error instanceof ExitGuardError) throw new TxGuardError(`Close transaction failed a safety check (${error.message}); nothing was sent.`);
    throw error;
  }
}

export const isDeadlinePassed = (deadline: string, nowSeconds = Math.floor(Date.now() / 1000)) => BigInt(nowSeconds) >= BigInt(deadline);

export const EXIT_EXPIRED_MESSAGE = "This close preview expired. Preview again to get fresh amounts.";

/** NFT ids this browser has seen for a wallet (opened here or added by hand). v4 PositionManager is not enumerable. */
const storageKey = (address: string) => `sofi:rhc:positions:${address.toLowerCase()}`;

export function trackedPositionIds(address: string, storage: Pick<Storage, "getItem"> | null = safeStorage()): string[] {
  try {
    const raw = storage?.getItem(storageKey(address));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && /^[0-9]{1,30}$/.test(x)).slice(0, 10) : [];
  } catch { return []; }
}

export function saveTrackedPositionIds(address: string, ids: string[], storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try { storage?.setItem(storageKey(address), JSON.stringify([...new Set(ids)].slice(0, 10))); } catch { /* storage full or disabled */ }
}

export function trackPositionId(address: string, id: string): string[] {
  const next = [id, ...trackedPositionIds(address).filter(x => x !== id)];
  saveTrackedPositionIds(address, next);
  return trackedPositionIds(address);
}

export function untrackPositionId(address: string, id: string): string[] {
  saveTrackedPositionIds(address, trackedPositionIds(address).filter(x => x !== id));
  return trackedPositionIds(address);
}

function safeStorage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

export type WalletBalances = { eth: bigint; tokens: Record<string, bigint> };

/** Read-only balances through the wallet provider (eth_getBalance / eth_call; never a signing request). */
export async function readWalletBalances(provider: Eip1193Provider, address: string, tokens: readonly string[]): Promise<WalletBalances> {
  const [eth, ...values] = await Promise.all([
    provider.request({ method: "eth_getBalance", params: [address, "latest"] }),
    ...tokens.map(token => provider.request({ method: "eth_call", params: [{ to: token, data: encodeFunctionData({ abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address as `0x${string}`] }) }, "latest"] })),
  ]);
  const big = (v: unknown) => (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) && v !== "0x" ? BigInt(v) : 0n);
  return { eth: big(eth), tokens: Object.fromEntries(tokens.map((t, i) => [t.toLowerCase(), big(values[i])])) };
}
