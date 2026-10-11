"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

export function AssetRisksDialog({ open, onOpenChange, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return <dialog ref={dialogRef} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onOpenChange(false); }}
    onClose={() => onOpenChange(false)}
    className="fixed left-1/2 top-1/2 m-0 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[28px] border border-white/15 bg-char p-6 text-cream shadow-2xl backdrop:bg-black/70 sm:p-8">
    <h2 id={titleId} className="text-xl font-semibold">Detailed information and asset risks</h2>
    <div className="mt-5 space-y-3 break-words text-sm leading-6 text-smoke [overflow-wrap:anywhere]">{children}</div>
    <button type="button" onClick={() => onOpenChange(false)}
      className="mt-6 w-full rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-lemon">
      Understand
    </button>
  </dialog>;
}
