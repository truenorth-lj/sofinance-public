import "@/lib/engine-host";
import "server-only";
import { rpcConnection } from "@sofinance/engine/rpc";
import { readSignatureFinality, type FinalityStatus } from "@/lib/transaction-finality";
import { sendServerEvents, type ServerEvent } from "@/lib/analytics/server-capture";
import type { McpOpenToConfirm } from "./analytics";

/**
 * After an MCP open is broadcast, wait (after the response) until it is `confirmed`, then send
 * `open_position_success` so north-star counts it on the same bar as the web (confirmed on-chain).
 *
 * Bounded: about 30 s and at most 15 status calls (one `getSignatureStatuses` per poll, plus `getBlockHeight` only
 * while the signature is not found and the prepare's lastValidBlockHeight is known). Stops early on failed or
 * expired. A timeout sends nothing more: the open stays `open_position_submitted` only.
 */
export const OPEN_CONFIRM_DEADLINE_MS = 30_000;
export const OPEN_CONFIRM_MAX_POLLS = 15;
const POLL_INTERVAL_MS = 2_000;

type Deps = {
  readStatus: (input: { signature: string; lastValidBlockHeight?: number }) => Promise<FinalityStatus>;
  send: (events: ServerEvent[]) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const defaultDeps = (): Deps => ({
  readStatus: async (input) => (await readSignatureFinality(rpcConnection(), { ...input, commitment: "confirmed" })).status,
  send: (events) => sendServerEvents(events),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

export async function captureMcpOpenWhenConfirmed(open: McpOpenToConfirm, deps: Deps = defaultDeps()): Promise<FinalityStatus | "timeout"> {
  const deadline = deps.now() + OPEN_CONFIRM_DEADLINE_MS;
  for (let poll = 0; poll < OPEN_CONFIRM_MAX_POLLS; poll++) {
    await deps.sleep(POLL_INTERVAL_MS);
    let status: FinalityStatus;
    try {
      status = await deps.readStatus({ signature: open.signature, lastValidBlockHeight: open.lastValidBlockHeight });
    } catch {
      status = "pending"; // a transient RPC error is retried until the bound
    }
    if (status === "confirmed" || status === "finalized") {
      await deps.send([open.event]);
      return status;
    }
    if (status === "failed" || status === "expired") return status;
    if (deps.now() + POLL_INTERVAL_MS > deadline) break;
  }
  return "timeout";
}
