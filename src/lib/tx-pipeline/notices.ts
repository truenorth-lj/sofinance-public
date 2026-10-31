"use client";

import { useSyncExternalStore } from "react";
import { captureTxClientFailure, type TxReportContext } from "@/lib/sentry/client-tx";
import { notifyPositionHistoryChange } from "@/lib/position-history-refresh";
import { clearTxAttempt } from "./attempts";
import { pollSignature, type TxChainStatus } from "./confirm";
import { canRetry, FLOW_LABEL, plainTxError, txFailureKind, type TxFailureKind, type TxFlow } from "./errors";

export { solscanTxUrl } from "./confirm";

/**
 * Stage 4 (status + toast): one notice store for every flow. Notices live outside React, so
 * a transaction keeps reporting after its modal closes. The store owns no timers; the mounted
 * TxNoticeHost polls watched signatures and auto-dismisses successes.
 */
export type TxNoticeState = "loading" | "success" | "failure";
export type TxNotice = {
  id: string; flow: TxFlow; state: TxNoticeState; title: string; detail?: string;
  signature?: string; kind?: TxFailureKind | "landed";
  /** One-tap retry for failures we know left nothing on-chain. Only set while the flow is mounted. */
  retry?: () => void;
  /** Set on a sent transaction: the host polls it until it settles. */
  watch?: { lastValidBlockHeight: number; successTitle: string; wallet: string; positionMint?: string };
};

export const BALANCES_REFRESH_EVENT = "sofinance:balances-refresh";
export const SUCCESS_NOTICE_MS = 8_000;

const EMPTY: TxNotice[] = [];
let notices: TxNotice[] = EMPTY;
let counter = 0;
const listeners = new Set<() => void>();

function publish(next: TxNotice[]) {
  notices = next;
  for (const listener of listeners) listener();
}
export function subscribeTxNotices(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const getTxNotices = () => notices;
export const findTxNotice = (id: string) => notices.find((item) => item.id === id);

export function showTxNotice(notice: Omit<TxNotice, "id"> & { id?: string }) {
  const id = notice.id ?? `tx-${Date.now()}-${++counter}`;
  publish([...notices.filter((item) => item.id !== id), { ...notice, id }].slice(-4));
  return id;
}
export function dismissTxNotice(id: string) {
  if (notices.some((item) => item.id === id)) publish(notices.filter((item) => item.id !== id));
}
/** Drop a retry callback when its flow unmounts, so the toast never calls into a dead component. */
export function detachTxRetry(retry: () => void) {
  if (notices.some((item) => item.retry === retry)) publish(notices.map((item) => item.retry === retry ? { ...item, retry: undefined } : item));
}
export function resetTxNotices() { publish(EMPTY); }

export function useTxNotices() {
  return useSyncExternalStore(subscribeTxNotices, getTxNotices, () => EMPTY);
}

export function requestBalancesRefresh(detail: { flow: TxFlow; signature?: string }) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(BALANCES_REFRESH_EVENT, { detail }));
}

export const noticeIdFor = (signature: string) => `tx-${signature}`;

/**
 * The wallet threw after a sign-and-send request: a loading notice while we check Solana for it.
 * Nothing in it says "nothing was sent"; that only follows once the blockhash expired with no match.
 */
export function showTxCheckingNotice(flow: TxFlow) {
  return showTxNotice({ flow, state: "loading", title: "Checking Solana…",
    detail: "Your wallet returned an error, but the transaction may still have gone through. Checking Solana before anything else; please don't submit again yet (this can take up to about 90 seconds)." });
}

/**
 * A failure before or during send: plain words, Sentry for anything but a wallet rejection, and a
 * balances refresh (a wallet-stage failure may still have moved funds; the screen must not show stale balances).
 */
export function reportTxFailure(input: { flow: TxFlow; error: unknown; id?: string; signature?: string; retry?: () => void; context?: TxReportContext }) {
  const kind = txFailureKind(input.error);
  const message = plainTxError(input.error, kind);
  captureTxClientFailure(input.flow, kind, message, input.context);
  requestBalancesRefresh({ flow: input.flow, signature: input.signature });
  if (kind === "rejected") {
    if (input.id) dismissTxNotice(input.id);
    return { kind, message, retryable: false };
  }
  const retryable = canRetry(kind);
  showTxNotice({ id: input.id, flow: input.flow, state: "failure", kind, signature: input.signature,
    title: kind === "expired" ? `${FLOW_LABEL[input.flow]}: transaction expired`
      : kind === "not-sent" ? `${FLOW_LABEL[input.flow]}: nothing was sent` : `${FLOW_LABEL[input.flow]} failed`,
    detail: message, retry: retryable ? input.retry : undefined });
  return { kind, message, retryable };
}

/** Sent: show loading and hand the signature to the host for confirmation. */
export function trackTxSignature(input: {
  flow: TxFlow; signature: string; lastValidBlockHeight: number; wallet: string; successTitle: string;
  positionMint?: string; retry?: () => void;
}) {
  return showTxNotice({ id: noticeIdFor(input.signature), flow: input.flow, state: "loading", title: "Confirming on Solana…",
    detail: "Sent. Waiting for Solana to confirm it; you can close this window.", signature: input.signature, retry: input.retry,
    watch: { lastValidBlockHeight: input.lastValidBlockHeight, successTitle: input.successTitle, wallet: input.wallet, positionMint: input.positionMint } });
}

/** Apply a settled chain status: success or failure toast, attempt cleanup, balances refresh. */
export function settleTxNotice(id: string, status: TxChainStatus, storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">) {
  const notice = findTxNotice(id);
  if (!notice?.signature || !notice.watch) return;
  const { flow, signature, watch } = notice;
  if (status === "pending") {
    showTxNotice({ ...notice, state: "failure", kind: "unknown", watch: undefined, retry: undefined, title: "Still unconfirmed",
      detail: "We could not confirm this transaction yet. Check it on Solscan before trying again; it may still land." });
    return;
  }
  if (storage) clearTxAttempt(storage, watch.wallet, signature);
  if (status === "confirmed") {
    showTxNotice({ id, flow, state: "success", kind: "landed", title: watch.successTitle, detail: "Confirmed on Solana. Balances refreshed.", signature });
    if (watch.positionMint) notifyPositionHistoryChange(watch.positionMint, signature);
  } else if (status === "failed") {
    captureTxClientFailure(flow, "failed", "Transaction landed with an on-chain error");
    showTxNotice({ id, flow, state: "failure", kind: "failed", signature, retry: notice.retry,
      title: `${FLOW_LABEL[flow]} failed on-chain`,
      detail: "Solana ran it but a safety check (such as the price limit) stopped it, so nothing changed except the network fee." });
  } else {
    captureTxClientFailure(flow, "expired", "Signature not found before its block height expired");
    showTxNotice({ id, flow, state: "failure", kind: "expired", signature, retry: notice.retry,
      title: `${FLOW_LABEL[flow]}: transaction expired`, detail: plainTxError(new Error("blockhash expired"), "expired") });
  }
  requestBalancesRefresh({ flow, signature });
}

/** Host-side confirmation loop for one watched notice. */
export async function watchTxNotice(id: string, options: {
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">; fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>; intervalMs?: number; maxPolls?: number; isCancelled?: () => boolean;
} = {}) {
  const notice = findTxNotice(id);
  if (!notice?.signature || !notice.watch) return "pending" as const;
  const status = await pollSignature({ signature: notice.signature, lastValidBlockHeight: notice.watch.lastValidBlockHeight, ...options,
    isCancelled: () => !!options.isCancelled?.() || findTxNotice(id)?.state !== "loading" });
  if (options.isCancelled?.() || findTxNotice(id)?.state !== "loading") return status;
  settleTxNotice(id, status, options.storage);
  return status;
}
