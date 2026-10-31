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
  /** The transaction exactly as prepared (its check permit covers these bytes and the height below). */
  prepared: VersionedTransaction;
  /** Prepare-issued check permit (`sofinance:tx-landed:v1`); without it there is nothing to ask and the answer is "unknown". */
  landedPermit?: string;
  lastValidBlockHeight?: number;
  /** When we asked the wallet (ms); older signatures are not this attempt (the server never trusts it alone). */
  preparedAt: number;
  /** Signatures this browser already tracks (saved attempts): never this attempt, so the lookup skips them. */
  exclude?: readonly string[];
};
export type FindLanded = (check: LandedCheck, options?: { background?: boolean }) => Promise<LandedOutcome>;

/**
 * Foreground (wallet error other than a cancel; the form waits): poll every 4 s. Background (after a 4001 cancel;
 * the form is free): every 5 s. Either stops at the deadline with one final check. A blockhash lives ~60–90 s and
 * "not landed" needs it expired plus 20 blocks, so a real answer comes well inside the deadline.
 */
export const LANDED_POLL_INTERVAL_MS = 4_000;
export const LANDED_BACKGROUND_POLL_INTERVAL_MS = 5_000;
/** The longest the user can be held in "Checking Solana…" (plus one final ≤10 s request). */
export const LANDED_DEADLINE_MS = 120_000;
/** Each `/api/tx-landed` request is abandoned after this (the server's own budget is 8 s). */
export const LANDED_REQUEST_TIMEOUT_MS = 10_000;
/** What the checking toast promises: deadline plus the final request, rounded to what people read. */
export const LANDED_MAX_WAIT_COPY = "about 2 minutes";

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function waitForLanded(check: LandedCheck, options: {
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number;
  intervalMs?: number; deadlineMs?: number; background?: boolean; isCancelled?: () => boolean;
} = {}): Promise<LandedOutcome> {
  // No check permit (e.g. the agent sign page, which has no prepare-time block height): answer at once.
  if (!check.landedPermit || !Number.isSafeInteger(check.lastValidBlockHeight) || !check.lastValidBlockHeight) return { status: "unknown" };
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? (options.background ? LANDED_BACKGROUND_POLL_INTERVAL_MS : LANDED_POLL_INTERVAL_MS);
  const deadline = now() + (options.deadlineMs ?? LANDED_DEADLINE_MS);
  const unsignedTransaction = toBase64(check.prepared.serialize());
  let checked: string[] = [...(check.exclude ?? [])].slice(-100);
  for (let poll = 0; ; poll++) {
    if (options.isCancelled?.()) return { status: "unknown" };
    if (poll > 0) await sleep(intervalMs);
    // At or past the deadline: this is the final check.
    const final = now() >= deadline;
    try {
      const response = await fetchImpl("/api/tx-landed", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        signal: AbortSignal.timeout(LANDED_REQUEST_TIMEOUT_MS),
        body: JSON.stringify({ unsignedTransaction, landedPermit: check.landedPermit, lastValidBlockHeight: check.lastValidBlockHeight,
          preparedAt: check.preparedAt, ...(checked.length ? { checked } : {}) }),
      });
      // Refused (bad input / permit) or the check window closed: asking again will not help.
      if (response.status === 400 || response.status === 410) return { status: "unknown" };
      if (response.ok) {
        const body = await response.json() as { status?: string; signature?: string; checked?: unknown };
        if ((body.status === "landed" || body.status === "failed") && typeof body.signature === "string" && body.signature) {
          return { status: body.status, signature: body.signature };
        }
        if (body.status === "not-landed") return { status: "not-landed" };
        if (Array.isArray(body.checked)) checked = body.checked.filter((item): item is string => typeof item === "string").slice(-200);
      }
    } catch { /* offline, timed out or aborted: keep checking */ }
    if (final) return { status: "unknown" };
  }
}
