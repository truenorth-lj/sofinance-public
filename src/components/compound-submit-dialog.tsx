"use client";

import { useEffect, useRef } from "react";
import { ArrowUpRight, CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import type { CompoundSubmitFeedback } from "./use-compound-controller";
import { solscanTxUrl } from "@/lib/format/explorer";
import { OK_RELEASE_KEYFRAMES, OK_RELEASE_MS } from "@/lib/compound-celebration/coins";

export function compoundSubmitCopy(feedback: CompoundSubmitFeedback, slow = false) {
  switch (feedback.phase) {
    case "submitting": return { title: "Submitting…", detail: "Sending your signed compound transaction to Solana." };
    case "confirming": return { title: "Confirming…", detail: slow
      ? "Still waiting for Solana to confirm. You can close this window; we keep checking and the result will show on this page. Do not compound again until it settles."
      : "Waiting for Solana to confirm the transaction. This usually takes a few seconds." };
    case "success": return { title: "Compound confirmed", detail: "Your harvested fees were added back to the position. Press OK to refresh the remaining Harvest." };
    case "failed": return { title: "Compound failed", detail: feedback.message || "The transaction did not complete." };
  }
}

/**
 * Modal status for a signed one-click compound: submitting → confirming → success / failed.
 * On "Compound confirmed", OK shrinks while pressed and, with `onCelebrate`, pops back on release: the coins leave from
 * it at that moment (`onCelebrate` gets its box) and the dialog closes OK_RELEASE_MS later. Reduced motion: no pop, it
 * closes at once.
 */
export function CompoundSubmitDialog({ feedback, slow = false, onDismiss, onCelebrate }: {
  feedback: CompoundSubmitFeedback | null; slow?: boolean; onDismiss: () => void; onCelebrate?: (okButton: DOMRect) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const releasing = useRef<number | null>(null);
  const open = feedback !== null;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);
  // A pending close belongs to the dialog that started it.
  useEffect(() => () => { if (releasing.current !== null) { window.clearTimeout(releasing.current); releasing.current = null; } }, [feedback?.signature]);
  if (!feedback) return null;
  const copy = compoundSubmitCopy(feedback, slow);
  const active = feedback.phase === "submitting" || feedback.phase === "confirming";
  const successful = feedback.phase === "success";
  return <dialog ref={dialogRef} onCancel={(event) => { if (active && !slow) event.preventDefault(); }} onClose={onDismiss}
    aria-labelledby="compound-submit-title" aria-describedby="compound-submit-detail"
    className="fixed left-1/2 top-1/2 w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-white/15 bg-char p-0 text-cream shadow-2xl backdrop:bg-black/70">
    <div className="p-6 sm:p-8">
      <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${successful ? "bg-mint/10 text-mint" : active ? "bg-lilac/10 text-lilac" : "bg-lemon/10 text-lemon"}`}>
        {successful ? <CheckCircle2 className="h-6 w-6" /> : active ? <LoaderCircle className="h-6 w-6 animate-spin" /> : <CircleAlert className="h-6 w-6" />}
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h2 id="compound-submit-title" className="mt-5 text-2xl font-semibold">{copy.title}</h2>
        <p id="compound-submit-detail" className="mt-2 text-sm leading-6 text-cream/80">{copy.detail}</p>
      </div>
      <a href={solscanTxUrl(feedback.signature)} target="_blank" rel="noreferrer"
        className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-lilac underline underline-offset-4">View on Solscan <ArrowUpRight className="h-4 w-4" /></a>
      <div className="mt-6 flex gap-3">
        {(!active || slow) && <button type="button" autoFocus onClick={(event) => {
          if (!successful || !onCelebrate) { onDismiss(); return; }
          if (releasing.current !== null) return;
          const button = event.currentTarget;
          onCelebrate(button.getBoundingClientRect());
          const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          if (reduced || typeof button.animate !== "function") { onDismiss(); return; }
          button.animate([...OK_RELEASE_KEYFRAMES], { duration: OK_RELEASE_MS, easing: "ease-out" }).finished?.catch(() => {});
          releasing.current = window.setTimeout(() => { releasing.current = null; onDismiss(); }, OK_RELEASE_MS);
        }}
          className={successful ? "inline-flex w-full items-center justify-center rounded-full bg-lemon px-5 py-3.5 text-sm font-semibold text-ink transition-transform duration-75 hover:bg-[#fff27f] motion-safe:active:scale-[0.94]"
            : "inline-flex w-full items-center justify-center rounded-full border border-white/20 px-5 py-3.5 text-sm font-semibold text-cream/90 hover:bg-white/[0.06]"}>
          {successful ? "OK" : "Close"}
        </button>}
      </div>
    </div>
  </dialog>;
}
