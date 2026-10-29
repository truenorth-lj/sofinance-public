import { UNIV4_RHC } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { PINNED_UNIVERSAL_ROUTER } from "@sofinance/engine/protocols/uniswap-v4/open-constants";
import type { TxView } from "@sofinance/engine/protocols/uniswap-v4/open-flow";
import { currentChainId, type Eip1193Provider, ensureRobinhoodChain, RHC_CHAIN_ID, WalletRequestError } from "./eip1193";

/**
 * Client-side checks before the wallet is asked to send a Robinhood Chain open transaction (design §3.5 / §6).
 * The server already guards the plan; this is the last refusal before `eth_sendTransaction`, so a wrong chain,
 * router, sender or a non-zero value never reaches the wallet.
 */

export const RHC_EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/";
export const explorerTxUrl = (hash: string) => `${RHC_EXPLORER_TX}${hash}`;

export const SIGNATURE_EXPIRED_MESSAGE = "The Permit2 signature expired. Preview again to get a fresh quote and signature.";

export class TxGuardError extends Error {
  constructor(message: string) { super(message); this.name = "TxGuardError"; }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const isZero = (value: unknown) => typeof value === "string" && /^0x0*$/i.test(value);

/** EIP-1193 `eth_sendTransaction` params from a server `TxView`: only from/to/data/value/gas (hex). */
export function walletTxParams(tx: TxView) {
  return { from: tx.from, to: tx.to, data: tx.data, value: "0x0", ...(tx.gasLimit ? { gas: `0x${BigInt(tx.gasLimit).toString(16)}` } : {}) };
}

/** Throws `TxGuardError` unless the tx is a zero-value call from `user` to `expectedTo` on chain 4663. */
export function checkTx(tx: TxView, user: string, expectedTo: string, what: string): void {
  if (tx.chainId !== RHC_CHAIN_ID) throw new TxGuardError(`${what} is not for Robinhood Chain (4663); nothing was sent.`);
  if (!same(tx.to, expectedTo)) throw new TxGuardError(`${what} targets an unexpected contract (${tx.to}); nothing was sent.`);
  if (!same(tx.from, user)) throw new TxGuardError(`${what} is not from the connected wallet; nothing was sent.`);
  if (!isZero(tx.value)) throw new TxGuardError(`${what} sends native ETH (value ${String(tx.value)}); nothing was sent.`);
}

export const checkExecuteTx = (tx: TxView, user: string) => checkTx(tx, user, PINNED_UNIVERSAL_ROUTER.address, "Open transaction");

/** Switch/confirm chain 4663 right before sending; refuses if the wallet is still elsewhere. */
export async function requireRobinhoodChain(provider: Eip1193Provider): Promise<void> {
  await ensureRobinhoodChain(provider);
  if (await currentChainId(provider) !== RHC_CHAIN_ID) throw new WalletRequestError("chain", "Wallet is not on Robinhood Chain (4663); nothing was sent.");
}

export const isPermitExpired = (sigDeadline: string, nowSeconds = Math.floor(Date.now() / 1000)) => BigInt(nowSeconds) >= BigInt(sigDeadline);

export type TxReceipt = { status?: string; logs?: { address?: string; topics?: string[] }[] };

/** Read-only receipt poll through the wallet provider (not a signing request). `null` on timeout. */
export async function waitForReceipt(provider: Eip1193Provider, hash: string, { intervalMs = 2_000, timeoutMs = 120_000 } = {}): Promise<TxReceipt | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null);
    if (receipt && typeof receipt === "object") return receipt as TxReceipt;
    if (Date.now() + intervalMs > end) return null;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = `0x${"0".repeat(64)}`;

/** Position NFT id from the PositionManager `Transfer(0x0 → user, id)` mint log, if present. */
export function mintedPositionId(receipt: TxReceipt, user: string): string | null {
  const log = receipt.logs?.find(l => l.address && same(l.address, UNIV4_RHC.positionManager) && l.topics?.length === 4 && same(l.topics[0]!, TRANSFER_TOPIC)
    && same(l.topics[1]!, ZERO_TOPIC) && same(`0x${l.topics[2]!.slice(-40)}`, user));
  return log ? BigInt(log.topics![3]!).toString() : null;
}
