import "@/lib/engine-host";
/**
 * App wrapper around the engine fee-estimate helper. Supplies the host
 * `defaultRpcConnection` fallback so existing callers stay unchanged.
 */
import type { Commitment, Connection, Message, VersionedMessage } from "@solana/web3.js";
import * as engineRpc from "@sofinance/engine/rpc";
import {
  CLEANUP_FEE_ESTIMATE_MESSAGE,
  COMPOUND_FEE_ESTIMATE_MESSAGE,
  estimateFeeForMessage as estimateEngineFeeForMessage,
  FEE_ESTIMATE_ATTEMPTS,
  FEE_ESTIMATE_BACKOFF_MS,
  FEE_ESTIMATE_TIMEOUT_MESSAGE,
  FEE_ESTIMATE_TIMEOUT_MS,
  isEmptyFeeEstimate,
  isTransientFeeEstimateError as isEngineTransientFeeEstimateError,
  OPEN_FEE_ESTIMATE_MESSAGE,
  RECOVERY_FEE_ESTIMATE_MESSAGE,
  WITHDRAW_FEE_ESTIMATE_MESSAGE,
  withFeeEstimateRetry,
} from "@sofinance/engine/rpc/fee-estimate";

export {
  CLEANUP_FEE_ESTIMATE_MESSAGE,
  COMPOUND_FEE_ESTIMATE_MESSAGE,
  FEE_ESTIMATE_ATTEMPTS,
  FEE_ESTIMATE_BACKOFF_MS,
  FEE_ESTIMATE_TIMEOUT_MESSAGE,
  FEE_ESTIMATE_TIMEOUT_MS,
  isEmptyFeeEstimate,
  OPEN_FEE_ESTIMATE_MESSAGE,
  RECOVERY_FEE_ESTIMATE_MESSAGE,
  WITHDRAW_FEE_ESTIMATE_MESSAGE,
  withFeeEstimateRetry,
};

export const FEE_ESTIMATE_USER_MESSAGE = "Network fee estimate is temporarily unavailable. Retry in a moment.";

export function isTransientFeeEstimateError(error: unknown) {
  return isEngineTransientFeeEstimateError(error);
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
  return estimateEngineFeeForMessage(connection, message, commitment, {
    fallback: options.fallback ?? hostDefaultRpcConnection(),
    sleep: options.sleep,
    emptyError: options.emptyError ?? OPEN_FEE_ESTIMATE_MESSAGE,
    timeoutMs: options.timeoutMs,
  });
}

function hostDefaultRpcConnection() {
  return "defaultRpcConnection" in engineRpc ? engineRpc.defaultRpcConnection : undefined;
}
