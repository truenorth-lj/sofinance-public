import { captureTxWalletErrorLanded, type TxReportContext } from "@/lib/sentry/client-tx";
import { saveTxAttempt } from "./attempts";
import type { TxFlow, TxWalletCancelledError } from "./errors";
import { cancelNoticeIdFor, dismissTxNotice, findTxNotice, noticeIdFor, requestBalancesRefresh, trackTxSignature } from "./notices";

/**
 * After a wallet cancel (code 4001) on a sign-and-send request the form is already unlocked and the
 * cancel toast is up. Wallets can still have broadcast, so the on-chain lookup carries on silently until the
 * blockhash expires. Landed (or landed-but-failed): this attempt's cancel toast is replaced by the normal
 * signature-keyed tracking (confirming → success toast with Solscan link + balance refresh, or the on-chain
 * failure). Not landed, or undecided: stay silent. Each attempt is keyed by its own cancel id and signature, so
 * a resubmit running meanwhile is never overwritten.
 */
export function watchCancelledSend(error: TxWalletCancelledError, track: {
  flow: TxFlow; successTitle: string; wallet: string; lastValidBlockHeight: number;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">; positionMint?: string; retry?: () => void;
  context?: TxReportContext;
  /**
   * Called once with the landed (or landed-but-failed) signature, also when another attempt already tracks it:
   * the flow's own bookkeeping (e.g. the step 1/2 swap attempt) must exist either way. Errors are swallowed.
   */
  onLanded?: (signature: string) => void;
}): Promise<void> {
  return error.landed.then((outcome) => {
    if (outcome.status !== "landed" && outcome.status !== "failed") return;
    const { signature } = outcome;
    dismissTxNotice(cancelNoticeIdFor(error));
    captureTxWalletErrorLanded(track.flow, { ...track.context, landedCheck: outcome.status, afterCancel: true });
    const bookkeeping = () => { try { track.onLanded?.(signature); } catch { /* must not hide a landed signature */ } };
    // Another attempt may already track this exact signature (identical bytes): never reset its state.
    if (findTxNotice(noticeIdFor(signature))) { bookkeeping(); return; }
    const attempt = { version: 1 as const, flow: track.flow, wallet: track.wallet, signature,
      lastValidBlockHeight: track.lastValidBlockHeight, createdAt: Date.now(), successTitle: track.successTitle,
      positionMint: track.positionMint };
    if (track.storage) saveTxAttempt(track.storage, attempt);
    trackTxSignature({ ...attempt, retry: track.retry });
    // Funds moved after the user saw "cancelled": refresh now (confirmation refreshes again).
    requestBalancesRefresh({ flow: track.flow, signature });
    bookkeeping();
  }, () => undefined);
}
