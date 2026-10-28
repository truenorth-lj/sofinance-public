/**
 * `getFeeForMessage` occasionally returns `{ value: null }` on a healthy RPC.
 * That is a successful JSON-RPC result, so the engine's error failover never
 * runs and prepare/withdraw fail the whole flow. Retry the same connection,
 * then the public/failover RPC. Does not change the fee charged — same message.
 */
import type { Commitment, Connection, Message, VersionedMessage } from "@solana/web3.js";

export const FEE_ESTIMATE_ATTEMPTS = 3;
export const FEE_ESTIMATE_BACKOFF_MS = 80;
export const FEE_ESTIMATE_TIMEOUT_MS = 4_000;

export const OPEN_FEE_ESTIMATE_MESSAGE = "Unable to estimate complete transaction network fee";
export const WITHDRAW_FEE_ESTIMATE_MESSAGE = "Cannot calculate transaction network cost";
export const COMPOUND_FEE_ESTIMATE_MESSAGE = "Unable to estimate compound network fee";
export const RECOVERY_FEE_ESTIMATE_MESSAGE = "Unable to estimate recovery transaction fee";
export const CLEANUP_FEE_ESTIMATE_MESSAGE = "Unable to estimate cleanup fee";
export const FEE_ESTIMATE_TIMEOUT_MESSAGE = "Fee estimate timed out";

export function isEmptyFeeEstimate(result: { value: number | null } | null | undefined) {
  return result === null || result === undefined || result.value === null || result.value === undefined
    || !Number.isSafeInteger(result.value) || result.value < 0;
}

export function isTransientFeeEstimateError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text === OPEN_FEE_ESTIMATE_MESSAGE || text === WITHDRAW_FEE_ESTIMATE_MESSAGE
    || text === COMPOUND_FEE_ESTIMATE_MESSAGE || text === RECOVERY_FEE_ESTIMATE_MESSAGE
    || text === CLEANUP_FEE_ESTIMATE_MESSAGE || text === FEE_ESTIMATE_TIMEOUT_MESSAGE;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(FEE_ESTIMATE_TIMEOUT_MESSAGE)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function estimateFeeForMessage(
  connection: Connection,
  message: Message | VersionedMessage,
  commitment: Commitment = "confirmed",
  options: {
    fallback?: () => Connection;
    sleep?: (ms: number) => Promise<void>;
    emptyError?: string;
    timeoutMs?: number;
  } = {},
): Promise<number> {
  const wait = options.sleep ?? sleep;
  const timeoutMs = options.timeoutMs ?? FEE_ESTIMATE_TIMEOUT_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < FEE_ESTIMATE_ATTEMPTS; attempt++) {
    try {
      const last = await withTimeout(() => connection.getFeeForMessage(message, commitment), timeoutMs);
      if (!isEmptyFeeEstimate(last)) return last.value!;
    } catch (error) {
      lastError = error;
      if (attempt >= FEE_ESTIMATE_ATTEMPTS - 1) break;
      await wait(FEE_ESTIMATE_BACKOFF_MS * (attempt + 1));
      continue;
    }
    if (attempt < FEE_ESTIMATE_ATTEMPTS - 1) await wait(FEE_ESTIMATE_BACKOFF_MS * (attempt + 1));
  }
  try {
    const fallback = options.fallback?.();
    if (fallback && fallback !== connection) {
      const last = await withTimeout(() => fallback.getFeeForMessage(message, commitment), timeoutMs);
      if (!isEmptyFeeEstimate(last)) return last.value!;
    }
  } catch {
    // Fallback RPC is optional; the original empty result is the failure.
  }
  if (lastError instanceof Error && lastError.message === FEE_ESTIMATE_TIMEOUT_MESSAGE) throw lastError;
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
