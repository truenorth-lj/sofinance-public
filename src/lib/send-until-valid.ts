/**
 * Land a already-signed transaction: one preflighted send, then rebroadcast the
 * same bytes until the signature is observed or `lastValidBlockHeight` passes.
 * Instructions and amounts stay identical.
 */
import type { Connection } from "@solana/web3.js";

export const REBROADCAST_INTERVAL_MS = 400;
/** Bound the HTTP request; the client keeps polling status after this. */
export const REBROADCAST_BUDGET_MS = 12_000;

export const FIRST_SEND_OPTIONS = {
  skipPreflight: false, preflightCommitment: "confirmed" as const, maxRetries: 0,
};
export const REBROADCAST_OPTIONS = {
  skipPreflight: true, preflightCommitment: "confirmed" as const, maxRetries: 0,
};

function observed(status: { err?: unknown; confirmationStatus?: string | null } | null | undefined) {
  if (!status) return null;
  if (status.err) return "failed";
  if (status.confirmationStatus === "processed" || status.confirmationStatus === "confirmed"
    || status.confirmationStatus === "finalized") return "landed";
  return null;
}

function alreadyProcessed(error: unknown) {
  return /already been processed|already processed/i.test(error instanceof Error ? error.message : String(error));
}

export async function sendUntilObserved(
  connection: Pick<Connection, "sendRawTransaction" | "getBlockHeight" | "getSignatureStatuses">,
  bytes: Buffer | Uint8Array,
  lastValidBlockHeight: number,
  options: { intervalMs?: number; budgetMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const intervalMs = options.intervalMs ?? REBROADCAST_INTERVAL_MS;
  const budgetMs = options.budgetMs ?? REBROADCAST_BUDGET_MS;
  const now = options.now ?? Date.now;
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const signature = await connection.sendRawTransaction(bytes, FIRST_SEND_OPTIONS);
  for (;;) {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    const state = observed(status);
    if (state === "failed") throw new Error("Transaction failed on chain");
    if (state === "landed") return signature;
    if (await connection.getBlockHeight("confirmed") > lastValidBlockHeight) return signature;
    if (now() - started >= budgetMs) return signature;
    try {
      await connection.sendRawTransaction(bytes, REBROADCAST_OPTIONS);
    } catch (error) {
      if (alreadyProcessed(error)) return signature;
    }
    await wait(intervalMs);
  }
}
