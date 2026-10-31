import type { VersionedTransaction } from "@solana/web3.js";

/**
 * Stage 2b (after a wallet error): did the transaction land anyway? Wallets can broadcast and then throw
 * (mainnet: Phantom threw `{"code":400,"message":"Request … rejected by user"}` three seconds after the
 * add landed), so a wallet error is never taken as "nothing was sent". This polls `/api/tx-landed`, which
 * finds the prepared transaction among the fee payer's recent signatures with the shared post-landing
 * matcher, until it lands, fails on-chain, or its blockhash has expired with no match.
 */
export type LandedOutcome =
  | { status: "landed" | "failed"; signature: string }
  | { status: "not-landed" }
  /** Could not decide (no permit, lookup kept failing, or the check ran out of time): never "nothing was sent". */
  | { status: "unknown" };

export type LandedCheck = {
  /** The transaction exactly as prepared (its send permit covers these bytes). */
  prepared: VersionedTransaction;
  sendPermit?: string;
  lastValidBlockHeight?: number;
  /** When we asked the wallet (ms); older signatures are not this attempt. */
  preparedAt: number;
};
export type FindLanded = (check: LandedCheck) => Promise<LandedOutcome>;

/** Blockhashes live ~60–90 s; this outlasts that with room for a slow wallet and RPC lag. */
export const LANDED_POLL_INTERVAL_MS = 3_000;
export const LANDED_MAX_POLLS = 80;

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitForLanded(check: LandedCheck, options: {
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; intervalMs?: number; maxPolls?: number; isCancelled?: () => boolean;
} = {}): Promise<LandedOutcome> {
  if (!check.sendPermit || !check.lastValidBlockHeight) return { status: "unknown" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const intervalMs = options.intervalMs ?? LANDED_POLL_INTERVAL_MS;
  const maxPolls = options.maxPolls ?? LANDED_MAX_POLLS;
  const unsignedTransaction = toBase64(check.prepared.serialize());
  let checked: string[] = [];
  for (let poll = 0; poll < maxPolls; poll++) {
    if (options.isCancelled?.()) return { status: "unknown" };
    if (poll > 0) await sleep(intervalMs);
    try {
      const response = await fetchImpl("/api/tx-landed", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ unsignedTransaction, sendPermit: check.sendPermit, lastValidBlockHeight: check.lastValidBlockHeight,
          preparedAt: check.preparedAt, ...(checked.length ? { checked } : {}) }),
      });
      // A refused request (bad input, no permit) will not get better by asking again.
      if (response.status === 400) return { status: "unknown" };
      if (!response.ok) continue;
      const body = await response.json() as { status?: string; signature?: string; checked?: unknown };
      if ((body.status === "landed" || body.status === "failed") && typeof body.signature === "string" && body.signature) {
        return { status: body.status, signature: body.signature };
      }
      if (body.status === "not-landed") return { status: "not-landed" };
      if (Array.isArray(body.checked)) checked = body.checked.filter((item): item is string => typeof item === "string").slice(-200);
    } catch { /* offline or aborted: keep checking */ }
  }
  return { status: "unknown" };
}
