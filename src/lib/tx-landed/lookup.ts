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
 * `lastValidBlockHeight` plus a margin, read BEFORE the scan) and every candidate in the window was
 * read and did not match. Anything less certain is "pending", never "not-landed".
 */
export type LandedLookupResult =
  | { status: "landed" | "failed"; signature: string }
  | { status: "pending"; checked: string[] }
  | { status: "not-landed" };

type LookupConnection = Pick<Connection, "getBlockHeight" | "getSignaturesForAddress" | "getTransaction">;

/** Blocks past `lastValidBlockHeight` before "nothing landed" is trusted (covers RPC index lag). */
export const LANDED_EXPIRY_MARGIN_BLOCKS = 20;
const PAGE_SIZE = 25;
const MAX_PAGES = 3;
/** getTransaction reads per request; the client sends back what was checked so the next poll continues. */
const MAX_READS = 12;

export async function findLandedTransaction(connection: LookupConnection, input: {
  wallet: string; prepared: VersionedTransaction; lastValidBlockHeight: number;
  /** Unix seconds; signatures older than this cannot be this attempt. */
  notBefore: number; checked?: readonly string[];
}): Promise<LandedLookupResult> {
  // Height first: if it is already past expiry, every block that could hold the transaction is confirmed before the scan.
  const height = await connection.getBlockHeight("confirmed");
  const expired = height > input.lastValidBlockHeight + LANDED_EXPIRY_MARGIN_BLOCKS;
  const skip = new Set(input.checked ?? []);
  const checked: string[] = [...skip];
  const address = new PublicKey(input.wallet);
  let complete = true;
  let reads = 0;
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const signatures = await connection.getSignaturesForAddress(address, { limit: PAGE_SIZE, ...(before ? { before } : {}) }, "confirmed");
    for (const entry of signatures) {
      if (typeof entry.blockTime === "number" && entry.blockTime < input.notBefore) return finish();
      if (skip.has(entry.signature)) continue;
      if (reads >= MAX_READS) { complete = false; return finish(); }
      reads += 1;
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
  // More history than the window holds inside the time bound: never claim "not landed" from a partial scan.
  complete = false;
  return finish();

  function finish(): LandedLookupResult {
    return expired && complete ? { status: "not-landed" } : { status: "pending", checked: checked.slice(-200) };
  }
}
