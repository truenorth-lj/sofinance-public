"use client";

import { useEffect, useRef, type Ref } from "react";
import { ArrowUpRight, CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import type { CompoundSubmitFeedback } from "./use-compound-controller";
import { solscanTxUrl } from "@/lib/format/explorer";

export function compoundSubmitCopy(feedback: CompoundSubmitFeedback, slow = false) {
  switch (feedback.phase) {
    case "submitting": return { title: "Submitting…", detail: "Sending your signed compound transaction to Solana." };
    case "confirming": return { title: "Confirming…", detail: slow
      ? "Still waiting for Solana to confirm. You can close this window; we keep checking and the result will show on this page. Do not compound again until it settles."
      : "Waiting for Solana to confirm the transaction. This usually takes a few seconds." };
    case "success": return { title: "Compound confirmed", detail: "Your harvested fees were added back to the position. Press Done to refresh it." };
    case "failed": return { title: "Compound failed", detail: feedback.message || "The transaction did not complete." };
  }
}

export const compoundSubmitActive = (feedback: CompoundSubmitFeedback | null) => feedback?.phase === "submitting" || feedback?.phase === "confirming";

/**
 * The status of a signed compound: submitting → confirming → success / failed. Shown inside the row's Compound popup
 * (`CompoundSubmitDialog` wraps the same content for the recovery page). Done / Close shows once it can be left.
 */
export function CompoundSubmitStatus({ feedback, slow = false, onDone, titleId = "compound-submit-title", doneRef }: {
  feedback: CompoundSubmitFeedback; slow?: boolean; onDone: () => void; titleId?: string;
  /** The Done button: where the success coins leave from while the popup is open. */
  doneRef?: Ref<HTMLButtonElement>;
}) {
  const copy = compoundSubmitCopy(feedback, slow);
  const active = compoundSubmitActive(feedback);
  const successful = feedback.phase === "success";
  return <div data-testid="compound-submit-status" data-phase={feedback.phase}>
    <div className={`mt-4 flex h-12 w-12 items-center justify-center rounded-2xl ${successful ? "bg-mint/10 text-mint" : active ? "bg-lilac/10 text-lilac" : "bg-lemon/10 text-lemon"}`}>
      {successful ? <CheckCircle2 className="h-6 w-6" /> : active ? <LoaderCircle className="h-6 w-6 animate-spin" /> : <CircleAlert className="h-6 w-6" />}
    </div>
    <div role="status" aria-live="polite" aria-atomic="true">
      <h3 id={titleId} className="mt-5 text-2xl font-semibold">{copy.title}</h3>
      <p id="compound-submit-detail" className="mt-2 text-sm leading-6 text-cream/80">{copy.detail}</p>
    </div>
    <a href={solscanTxUrl(feedback.signature)} target="_blank" rel="noreferrer"
      className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-lilac underline underline-offset-4">View on Solscan <ArrowUpRight className="h-4 w-4" /></a>
    <div className="mt-6 flex gap-3">
      {(!active || slow) && <button ref={doneRef} type="button" onClick={onDone} autoFocus data-testid="compound-submit-done"
        className={successful ? "inline-flex w-full items-center justify-center rounded-full bg-lemon px-5 py-3.5 text-sm font-semibold text-ink hover:bg-[#fff27f]"
          : "inline-flex w-full items-center justify-center rounded-full border border-white/20 px-5 py-3.5 text-sm font-semibold text-cream/90 hover:bg-white/[0.06]"}>
        {successful ? "Done" : "Close"}
      </button>}
    </div>
  </div>;
}

/** Modal status for a signed compound on the recovery page (the Portfolio shows it inside the row's Compound popup). */
export function CompoundSubmitDialog({ feedback, slow = false, onDismiss }: {
  feedback: CompoundSubmitFeedback | null; slow?: boolean; onDismiss: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = feedback !== null;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);
  if (!feedback) return null;
  const active = compoundSubmitActive(feedback);
  return <dialog ref={dialogRef} onCancel={(event) => { if (active && !slow) event.preventDefault(); }} onClose={onDismiss}
    aria-labelledby="compound-submit-title" aria-describedby="compound-submit-detail"
    className="fixed left-1/2 top-1/2 w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-white/15 bg-char p-0 text-cream shadow-2xl backdrop:bg-black/70">
    <div className="p-6 sm:p-8"><CompoundSubmitStatus feedback={feedback} slow={slow} onDone={onDismiss} /></div>
  </dialog>;
}
