import * as Sentry from "@sentry/nextjs";
import type { TxFailureKind, TxFlow } from "../tx-pipeline/errors";
import { isSentryEnabled } from "./runtime";

export type { TxFlow };

/**
 * Browser-side transaction failures that never reach a server route (expired before Solana
 * included them, refused before sending, failed on-chain). User rejections are not reported. Only the
 * public, already-sanitized message is attached; never keys, URLs or wallet addresses.
 */
export function captureTxClientFailure(flow: TxFlow, kind: TxFailureKind, message: string) {
  if (kind === "rejected") return;
  try {
    if (!isSentryEnabled()) return;
    Sentry.withScope((scope) => {
      scope.setLevel("warning");
      scope.setTag("tx_flow", flow);
      scope.setTag("tx_failure", kind);
      scope.setFingerprint(["tx-client-failure", flow, kind]);
      scope.setExtra("reason", message.slice(0, 300));
      Sentry.captureMessage(`Transaction ${flow} ${kind}`);
    });
  } catch { /* Telemetry must never break the transaction UI. */ }
}
