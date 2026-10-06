"use client";

import { useEffect, useRef } from "react";
import { ArrowUpRight, CheckCircle2, CircleAlert, Clock3, LoaderCircle, X } from "lucide-react";
import type { AtomicStatus } from "@/lib/attempt-status";
import type { SelectedAttempt } from "@/lib/selected-attempt";

const short = (value: string) => `${value.slice(0, 5)}…${value.slice(-5)}`;

export function transactionStatusCopy(status: AtomicStatus) {
  switch (status) {
    case "success": return { title: "Position increased successfully", detail: "Transaction confirmed on-chain and selected NFT liquidity increment verified." };
    case "failed": return { title: "On-chain transaction failed", detail: "Transaction submitted on-chain but execution failed. Please check transaction history; verify wallet balance before retrying." };
    case "expired": return { title: "Transaction not on-chain and expired", detail: "Transaction not found and valid block height has passed. Check transaction history before deciding to retry." };
    case "manual-review": return { title: "Transaction result requires manual verification", detail: "On-chain state does not match expectations, further deposits paused. Please verify transaction and position first." };
    case "pending": return { title: "Transaction confirming", detail: "Wallet signature obtained, verifying on-chain results. Do not resubmit before verification completes." };
  }
}

export function TransactionStatusDialog({ attempt, status, error, open, onOpenChange, onRetry }: {
  attempt: SelectedAttempt | null; status: AtomicStatus | null; error: string;
  open: boolean; onOpenChange: (open: boolean) => void; onRetry: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  if (!attempt) return null;

  const phase = status ?? "pending";
  const copy = transactionStatusCopy(phase);
  const active = phase === "pending";
  const successful = phase === "success";
  return <dialog ref={dialogRef} onClose={() => onOpenChange(false)} aria-labelledby="transaction-status-title"
    aria-describedby="transaction-status-detail"
    className="fixed left-1/2 top-1/2 w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-3xl border border-white/15 bg-[#111d2c] p-0 text-slate-100 shadow-2xl backdrop:bg-[#020711]/80">
    <div className="p-6 sm:p-8">
      <div className="flex items-start justify-between gap-4">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ${successful ? "bg-emerald-400/10 text-emerald-300" : active ? "bg-sky-400/10 text-sky-300" : "bg-amber-400/10 text-amber-300"}`}>
          {successful ? <CheckCircle2 className="h-6 w-6" /> : active ? <LoaderCircle className="h-6 w-6 animate-spin" /> : phase === "expired" ? <Clock3 className="h-6 w-6" /> : <CircleAlert className="h-6 w-6" />}
        </div>
        <button type="button" onClick={() => onOpenChange(false)} aria-label="Close transaction status"
          className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-sky-300"><X className="h-5 w-5" /></button>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true">
        <h2 id="transaction-status-title" className="mt-5 text-2xl font-semibold">{copy.title}</h2>
        <p id="transaction-status-detail" className="mt-2 text-sm leading-6 text-slate-300">{copy.detail}</p>
      </div>
      {error && (phase === "pending" || phase === "manual-review") &&
        <p role="alert" className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-sm text-amber-200">Verification message: {error}</p>}
      <div className="mt-6 rounded-2xl border border-white/10 bg-[#07101d] p-4">
        <p className="text-xs text-slate-400">Transaction hash</p>
        <a href={`https://solscan.io/tx/${attempt.signature}`} target="_blank" rel="noreferrer"
          className="mt-2 block break-all font-mono text-sm leading-6 text-sky-300 underline underline-offset-4 hover:text-sky-200">{attempt.signature} <ArrowUpRight className="inline h-4 w-4" /></a>
        <p className="mt-3 text-xs text-slate-400">Destination NFT: {short(attempt.selection.positionMint)}</p>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        {(phase === "pending" || phase === "manual-review") && <button type="button" onClick={onRetry}
          className="rounded-xl border border-sky-400/30 px-4 py-2 text-sm font-semibold text-sky-300 hover:bg-sky-400/10">Requery on-chain status</button>}
        <button type="button" onClick={() => onOpenChange(false)}
          className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-white/10">Close</button>
      </div>
    </div>
  </dialog>;
}
