import { isMinContextSlotError } from "./errors";

/** Public code for "our RPC node was behind the slot we just read". */
export const RPC_BEHIND_CODE = "rpc_behind";
/** Plain-language reason shown to users. Nothing is ever sent when this is raised. */
export const RPC_BEHIND_MESSAGE =
  "Our Solana node was a few seconds behind the network, so the safety check could not finish. Nothing was sent. Please try again.";
/** Wait before the single automatic retry (about two Solana slots). */
export const CONTEXT_SLOT_RETRY_DELAY_MS = 800;

export class RpcBehindError extends Error {
  readonly code = RPC_BEHIND_CODE;
  constructor(cause?: unknown) {
    super(RPC_BEHIND_MESSAGE);
    this.name = "RpcBehindError";
    this.cause = cause;
  }
}

/**
 * Run an RPC call that passes `minContextSlot`. A load-balanced node can lag the slot
 * we just read from (JSON-RPC -32016). Retry once after a short wait; if the node is
 * still behind, raise {@link RpcBehindError} with a plain-language message instead of
 * the raw RPC text. Any other error is rethrown unchanged.
 */
export async function withContextSlotRetry<T>(
  run: () => Promise<T>,
  options: { retries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const retries = options.retries ?? 1;
  const delayMs = options.delayMs ?? CONTEXT_SLOT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isMinContextSlotError(error)) throw error;
      if (attempt >= retries) throw new RpcBehindError(error);
      await sleep(delayMs);
    }
  }
}
