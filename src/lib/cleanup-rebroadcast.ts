/**
 * Re-sends the same signed cleanup transaction while it is not on Solana and its blockhash is still valid. A signed
 * transaction is idempotent (same signature), so this never needs another wallet approval and cannot execute twice.
 * It stops by itself once the transaction is seen, expires, or the attempt budget is spent. Pure: time and the send
 * are injected.
 */
export const CLEANUP_REBROADCAST_INTERVAL_MS = 6_000;
export const CLEANUP_REBROADCAST_MAX_ATTEMPTS = 12;

export type RebroadcastInput = {
  signature: string;
  /** From the confirm route: `false` = Solana has not seen it, `true` = seen, `undefined` = the RPC could not answer. */
  onChain: boolean | undefined;
  /** The prepared window's end (epoch ms); never re-send after it. */
  expiresAt: number;
  send: () => Promise<unknown>;
};
export type RebroadcastResult = "sent" | "failed" | "skipped";

export function createRebroadcaster(options: { intervalMs?: number; maxAttempts?: number; now?: () => number } = {}) {
  const intervalMs = options.intervalMs ?? CLEANUP_REBROADCAST_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? CLEANUP_REBROADCAST_MAX_ATTEMPTS;
  const now = options.now ?? Date.now;
  const lastAt = new Map<string, number>();
  const attempts = new Map<string, number>();
  const inFlight = new Set<string>();
  const failures: string[] = [];
  return {
    /** The initial broadcast counts as the first send, so the first re-send waits one interval. */
    markSent(signature: string) { lastAt.set(signature, now()); },
    attemptsFor: (signature: string) => attempts.get(signature) ?? 0,
    /** Messages of re-sends that errored (the original send is unaffected). */
    failures: () => [...failures],
    async tick(input: RebroadcastInput): Promise<RebroadcastResult> {
      const { signature } = input, at = now();
      if (input.onChain !== false || at >= input.expiresAt || inFlight.has(signature)) return "skipped";
      if ((attempts.get(signature) ?? 0) >= maxAttempts) return "skipped";
      if (at - (lastAt.get(signature) ?? 0) < intervalMs) return "skipped";
      inFlight.add(signature); lastAt.set(signature, at); attempts.set(signature, (attempts.get(signature) ?? 0) + 1);
      try { await input.send(); return "sent"; }
      catch (error) { failures.push(error instanceof Error ? error.message : String(error)); return "failed"; }
      finally { inFlight.delete(signature); }
    },
  };
}
export type CleanupRebroadcaster = ReturnType<typeof createRebroadcaster>;
