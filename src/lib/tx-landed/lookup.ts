import "@/lib/engine-host";
import "server-only";
import { PublicKey, type Connection, type VersionedTransaction } from "@solana/web3.js";
import { landedReceiptIsPrepared } from "@sofinance/engine/wallet-returned-tx";

/**
 * Did a transaction we prepared land, even though the wallet reported an error?
 *
 * Wallets sometimes broadcast a transaction and then throw anyway (seen on mainnet: Phantom returned
 * `{"code":400,"message":"Request … rejected by user"}` three seconds after the add had landed). The
 * signature is unknown, so this scans the fee payer's recent signatures and compares each candidate
 * with the prepared transaction using the shared post-landing matcher (`landedReceiptIsPrepared`).
 *
 * "not-landed" is only returned once the prepared blockhash has expired (confirmed block height past
 * `lastValidBlockHeight` plus a margin, read BEFORE the scan, with every later read pinned to that slot) and
 * every signature in the time window was either read and did not match, or was already checked by an earlier
 * poll (or is a signature this browser already tracks). Anything less certain is "pending", never "not-landed".
 */
export type LandedLookupResult =
  | { status: "landed" | "failed"; signature: string }
  | { status: "pending"; checked: string[] }
  | { status: "not-landed" };

type LookupConnection = Pick<Connection, "getEpochInfo" | "getSignaturesForAddress" | "getTransaction">;

/** Blocks past `lastValidBlockHeight` before "nothing landed" is trusted (covers RPC index lag). */
export const LANDED_EXPIRY_MARGIN_BLOCKS = 20;
/** The check window closes this many blocks after "nothing landed" could first be answered (~2 min): no polling forever. */
export const LANDED_CHECK_WINDOW_BLOCKS = 300;
const PAGE_SIZE = 25;
const MAX_PAGES = 2;
/** getTransaction reads per request; the client sends back what was checked so the next poll continues. */
const MAX_READS = 10;
/** Upper bound on RPC calls one request can make: epoch info + signature pages + transaction reads. */
export const LANDED_MAX_RPC_CALLS_PER_REQUEST = 1 + MAX_PAGES + MAX_READS;
/** Per-request time budget; past it the scan stops and answers "pending" (never "not-landed"). */
export const LANDED_REQUEST_BUDGET_MS = 8_000;

/** The blockhash is long gone: the route refuses further checks for it. */
export class LandedCheckWindowClosedError extends Error {
  constructor() { super("This transaction check has expired"); this.name = "LandedCheckWindowClosedError"; }
}

/** RPC -32016 "Minimum context slot has not been reached": the node answering is behind the height we read. */
function isNodeBehind(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return /-32016|minimum context slot/i.test(text);
}

export async function findLandedTransaction(connection: LookupConnection, input: {
  wallet: string; prepared: VersionedTransaction; lastValidBlockHeight: number;
  /** Unix seconds; signatures older than this cannot be this attempt. */
  notBefore: number; checked?: readonly string[];
  /** Absolute deadline (ms since epoch) for this request's RPC work. */
  deadline?: number; now?: () => number;
}): Promise<LandedLookupResult> {
  const now = input.now ?? Date.now;
  const deadline = input.deadline ?? now() + LANDED_REQUEST_BUDGET_MS;
  // Height and slot from ONE read, first. Every later read must come from a node at least at that slot
  // (minContextSlot), so a lagging provider behind a load balancer can never make an expired-and-empty answer.
  const epoch = await connection.getEpochInfo("confirmed");
  const height = epoch.blockHeight;
  if (typeof height !== "number") throw new Error("RPC did not return a block height");
  if (height > input.lastValidBlockHeight + LANDED_EXPIRY_MARGIN_BLOCKS + LANDED_CHECK_WINDOW_BLOCKS) {
    throw new LandedCheckWindowClosedError();
  }
  const expired = height > input.lastValidBlockHeight + LANDED_EXPIRY_MARGIN_BLOCKS;
  const minContextSlot = epoch.absoluteSlot;
  const skip = new Set(input.checked ?? []);
  const checked: string[] = [...skip];
  const address = new PublicKey(input.wallet);
  let complete = true;
  let reads = 0;
  let before: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (now() > deadline) return incomplete();
      const signatures = await connection.getSignaturesForAddress(address,
        { limit: PAGE_SIZE, minContextSlot, ...(before ? { before } : {}) }, "confirmed");
      for (const entry of signatures) {
        if (typeof entry.blockTime === "number" && entry.blockTime < input.notBefore) return finish();
        if (skip.has(entry.signature)) continue;
        if (reads >= MAX_READS || now() > deadline) return incomplete();
        reads += 1;
        // getTransaction has no minContextSlot; a lagging node answers null, which keeps the scan incomplete.
        const receipt = await connection.getTransaction(entry.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (!receipt?.meta) { complete = false; continue; }
        if (landedReceiptIsPrepared(input.prepared, receipt, input.wallet)) {
          return { status: receipt.meta.err ? "failed" : "landed", signature: entry.signature };
        }
        checked.push(entry.signature);
      }
      if (signatures.length < PAGE_SIZE) return finish();
      before = signatures.at(-1)!.signature;
    }
  } catch (error) {
    if (isNodeBehind(error)) return incomplete();
    throw error;
  }
  // More history than the window holds inside the time bound: never claim "not landed" from a partial scan.
  return incomplete();

  function incomplete(): LandedLookupResult {
    complete = false;
    return finish();
  }
  function finish(): LandedLookupResult {
    return expired && complete ? { status: "not-landed" } : { status: "pending", checked: checked.slice(-200) };
  }
}
