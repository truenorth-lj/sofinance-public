import "@/lib/engine-host";
/**
 * `getFeeForMessage` occasionally returns `{ value: null }` on a healthy RPC.
 * That is a successful JSON-RPC result, so the engine's error failover never
 * runs and prepare/withdraw fail the whole flow. Retry the same connection,
 * then the public/failover RPC. Does not change the fee charged — same message.
 */
import type { Commitment, Connection, Message, VersionedMessage } from "@solana/web3.js";
import { defaultRpcConnection } from "@sofinance/engine/rpc";

export const FEE_ESTIMATE_ATTEMPTS = 3;
export const FEE_ESTIMATE_BACKOFF_MS = 80;

export const OPEN_FEE_ESTIMATE_MESSAGE = "Unable to estimate complete transaction network fee";
export const WITHDRAW_FEE_ESTIMATE_MESSAGE = "Cannot calculate transaction network cost";

export function isEmptyFeeEstimate(result: { value: number | null } | null | undefined) {
  return result === null || result === undefined || result.value === null || result.value === undefined
    || !Number.isSafeInteger(result.value) || result.value < 0;
}

export function isTransientFeeEstimateError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text === OPEN_FEE_ESTIMATE_MESSAGE || text === WITHDRAW_FEE_ESTIMATE_MESSAGE
    || text === "Unable to estimate cleanup fee";
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function estimateFeeForMessage(
  connection: Connection,
  message: Message | VersionedMessage,
  commitment: Commitment = "confirmed",
  options: {
    fallback?: () => Connection;
    sleep?: (ms: number) => Promise<void>;
    emptyError?: string;
  } = {},
): Promise<number> {
  const wait = options.sleep ?? sleep;
  let last: { value: number | null } | null = null;
  for (let attempt = 0; attempt < FEE_ESTIMATE_ATTEMPTS; attempt++) {
    last = await connection.getFeeForMessage(message, commitment);
    if (!isEmptyFeeEstimate(last)) return last!.value!;
    if (attempt < FEE_ESTIMATE_ATTEMPTS - 1) await wait(FEE_ESTIMATE_BACKOFF_MS * (attempt + 1));
  }
  try {
    const fallback = (options.fallback ?? defaultRpcConnection)();
    if (fallback !== connection) {
      last = await fallback.getFeeForMessage(message, commitment);
      if (!isEmptyFeeEstimate(last)) return last!.value!;
    }
  } catch {
    // Fallback RPC is optional; the original empty result is the failure.
  }
  throw new Error(options.emptyError ?? OPEN_FEE_ESTIMATE_MESSAGE);
}

export async function withFeeEstimateRetry<T>(
  run: () => Promise<T>, attempts = FEE_ESTIMATE_ATTEMPTS,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isTransientFeeEstimateError(error)) throw error;
      await wait(FEE_ESTIMATE_BACKOFF_MS * attempt);
    }
  }
}
