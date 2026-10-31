import * as Sentry from "@sentry/nextjs";
import type { TxFailureKind, TxFlow } from "../tx-pipeline/errors";
import { isSentryEnabled } from "./runtime";

export type { TxFlow };

/** Public, non-secret context for a transaction report (never keys, URLs or wallet addresses). */
export type TxReportContext = {
  /** The prepared transaction's recent blockhash (public chain data; ties a report to one attempt). */
  blockhash?: string;
  /** Numeric code the wallet threw, e.g. 4001 or 400. */
  walletErrorCode?: number;
  /** What the on-chain lookup after a wallet error decided. */
  landedCheck?: "landed" | "failed" | "not-landed" | "unknown";
};

function applyContext(scope: Sentry.Scope, context: TxReportContext | undefined) {
  if (!context) return;
  if (context.blockhash) scope.setTag("tx_blockhash", context.blockhash);
  if (context.walletErrorCode !== undefined) scope.setTag("wallet_error_code", String(context.walletErrorCode));
  if (context.landedCheck) scope.setTag("tx_landed_check", context.landedCheck);
}

/**
 * The connected wallet's name (and Wallet Standard version when the wallet exposes one), set on the
 * global scope when a wallet connects so every report says which wallet was involved.
 */
export function setTxWalletTags(wallet: { name?: string; version?: string } | null) {
  try {
    if (!isSentryEnabled()) return;
    Sentry.setTag("wallet_name", wallet?.name || undefined);
    Sentry.setTag("wallet_version", wallet?.version || undefined);
  } catch { /* Telemetry must never break the wallet UI. */ }
}

/**
 * Browser-side transaction failures that never reach a server route (expired before Solana
 * included them, refused before sending, failed on-chain). User rejections are not reported. Only the
 * public, already-sanitized message is attached; never keys, URLs or wallet addresses.
 */
export function captureTxClientFailure(flow: TxFlow, kind: TxFailureKind, message: string, context?: TxReportContext) {
  if (kind === "rejected") return;
  try {
    if (!isSentryEnabled()) return;
    Sentry.withScope((scope) => {
      scope.setLevel("warning");
      scope.setTag("tx_flow", flow);
      scope.setTag("tx_failure", kind);
      applyContext(scope, context);
      scope.setFingerprint(["tx-client-failure", flow, kind]);
      scope.setExtra("reason", message.slice(0, 300));
      Sentry.captureMessage(`Transaction ${flow} ${kind}`);
    });
  } catch { /* Telemetry must never break the transaction UI. */ }
}

/** The wallet threw, but the transaction was found on-chain: not a user-facing failure, still worth counting per wallet. */
export function captureTxWalletErrorLanded(flow: TxFlow, context: TxReportContext) {
  try {
    if (!isSentryEnabled()) return;
    Sentry.withScope((scope) => {
      scope.setLevel("info");
      scope.setTag("tx_flow", flow);
      applyContext(scope, context);
      scope.setFingerprint(["tx-wallet-error-landed", flow]);
      Sentry.captureMessage(`Transaction ${flow} landed after a wallet error`);
    });
  } catch { /* Telemetry must never break the transaction UI. */ }
}
