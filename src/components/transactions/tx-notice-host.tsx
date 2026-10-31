"use client";

import { useEffect, useRef } from "react";
import { ArrowUpRight, CheckCircle2, CircleAlert, LoaderCircle, RotateCcw, X } from "lucide-react";
import {
  dismissTxNotice, findTxNotice, getTxNotices, loadTxAttempts, noticeIdFor, showTxNotice, solscanTxUrl,
  SUCCESS_NOTICE_MS, useTxNotices, watchTxNotice, type TxNotice,
} from "@/lib/tx-pipeline";

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;

function NoticeIcon({ state }: { state: TxNotice["state"] }) {
  if (state === "loading") return <LoaderCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-lemon" />;
  if (state === "success") return <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-mint" />;
  return <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-coral" />;
}

/** Re-attach saved signatures after a reload so they settle (and get cleared) instead of lingering. */
export function useResumeTxAttempts(wallet: string | undefined) {
  useEffect(() => {
    if (!wallet || typeof window === "undefined") return;
    for (const attempt of loadTxAttempts(window.localStorage, wallet)) {
      const id = noticeIdFor(attempt.signature);
      if (findTxNotice(id)) continue;
      showTxNotice({ id, flow: attempt.flow, state: "loading", title: "Checking a previous transaction…",
        detail: "Sent earlier. Waiting for Solana to confirm it.", signature: attempt.signature,
        watch: { lastValidBlockHeight: attempt.lastValidBlockHeight, successTitle: attempt.successTitle, wallet,
          positionMint: attempt.positionMint } });
    }
  }, [wallet]);
}

/** Global transaction notices; mounted once so they survive modal close. */
export function TxNoticeHost({ wallet }: { wallet?: string }) {
  useResumeTxAttempts(wallet);
  const notices = useTxNotices();
  const watched = useRef(new Set<string>());
  const dismissals = useRef(new Map<string, number>());
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    const timers = dismissals.current;
    return () => { unmounted.current = true; for (const timer of timers.values()) window.clearTimeout(timer); };
  }, []);
  useEffect(() => {
    for (const notice of notices) {
      if (notice.state === "loading" && notice.watch && notice.signature && !watched.current.has(notice.id)) {
        watched.current.add(notice.id);
        void watchTxNotice(notice.id, { storage: window.localStorage, isCancelled: () => unmounted.current })
          .finally(() => watched.current.delete(notice.id));
      }
      if (notice.state === "success" && !dismissals.current.has(notice.id)) {
        dismissals.current.set(notice.id, window.setTimeout(() => {
          dismissals.current.delete(notice.id);
          if (getTxNotices().find((item) => item.id === notice.id)?.state === "success") dismissTxNotice(notice.id);
        }, SUCCESS_NOTICE_MS));
      }
    }
  }, [notices]);
  if (!notices.length) return null;
  return <div className="pointer-events-none fixed inset-x-3 bottom-3 z-[60] flex flex-col gap-2 sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[380px]"
    aria-live="polite">
    {notices.map((notice) => <div key={notice.id} role={notice.state === "failure" ? "alert" : "status"}
      data-tx-notice={notice.state}
      className="pointer-events-auto flex gap-3 rounded-2xl border border-white/15 bg-char/95 p-3 text-xs text-cream/90 shadow-lg backdrop-blur">
      <NoticeIcon state={notice.state} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold text-cream">{notice.title}</p>
        {notice.detail && <p className="leading-5 text-smoke">{notice.detail}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {notice.signature && <a className="inline-flex items-center gap-1 underline" href={solscanTxUrl(notice.signature)} target="_blank" rel="noreferrer">
            View {short(notice.signature)} on Solscan <ArrowUpRight aria-hidden className="h-3 w-3" /></a>}
          {notice.state === "failure" && notice.retry && <button type="button" data-testid="tx-notice-retry"
            onClick={() => { const retry = notice.retry; dismissTxNotice(notice.id); retry?.(); }}
            className="inline-flex items-center gap-1 rounded-full bg-lemon px-2.5 py-1 font-semibold text-char">
            <RotateCcw aria-hidden className="h-3 w-3" /> Try again</button>}
        </div>
      </div>
      {notice.state !== "loading" && <button type="button" onClick={() => dismissTxNotice(notice.id)} aria-label="Dismiss notice"
        className="self-start rounded p-0.5 text-smoke hover:text-cream"><X className="h-3.5 w-3.5" /></button>}
    </div>)}
  </div>;
}
