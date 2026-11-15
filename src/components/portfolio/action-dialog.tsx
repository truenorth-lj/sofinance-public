"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

const SIZES = { sm: "sm:max-w-md", md: "sm:max-w-2xl", lg: "sm:max-w-5xl" } as const;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Popups can overlap during target changes. Restore the page only after the last one closes.
let openCount = 0;
let savedOverflow = "";
function lockPage() {
  const root = document.documentElement;
  if (openCount++ === 0) {
    savedOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    root.setAttribute("data-portfolio-popup-open", "");
  }
  return () => {
    if (--openCount === 0) {
      root.style.overflow = savedOverflow;
      root.removeAttribute("data-portfolio-popup-open");
    }
  };
}

/**
 * A Portfolio popup (Compound / Add / Withdraw / Activity / a position's Performance): a modal on desktop, a bottom sheet
 * on a phone. Closing only hides it: its content stays mounted, so a transaction that is still running (a withdrawal's
 * second step, a compound being confirmed) keeps running and shows again when the popup is reopened.
 * `dismissible={false}` while closing would hide a step the user must wait for (Escape, the backdrop and × do nothing).
 *
 * It is a non-modal `<dialog>` with its own backdrop, focus trap and Escape, not `showModal()`: a top-layer modal would
 * cover (and make inert) the transaction notices that report this popup's own sends. Nested dialogs that need the top
 * layer (the asset picker, the transaction status) still open above it.
 */
export function ActionDialog({ open, onClose, title, testId, size = "md", dismissible = true, children }: {
  open: boolean; onClose: () => void; title: ReactNode; testId: string; size?: keyof typeof SIZES; dismissible?: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) { if (dialog.show) dialog.show(); else dialog.setAttribute("open", ""); }
    dialog.focus({ preventScroll: true });
    // The page behind does not scroll while a popup is open.
    const unlock = lockPage();
    return () => {
      unlock();
      if (dialog.open) { if (dialog.close) dialog.close(); else dialog.removeAttribute("open"); }
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    // Keys meant for a dialog opened inside this one (the asset picker) stay there.
    if (!(event.target instanceof Element) || event.target.closest("dialog") !== event.currentTarget) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (dismissible) onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => node.closest("dialog") === event.currentTarget);
    const first = focusable[0], last = focusable.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === event.currentTarget)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };
  return <>
    {open && <div aria-hidden="true" data-testid={`${testId}-backdrop`} className="fixed inset-0 z-[55] bg-black/70"
      onClick={() => { if (dismissible) onClose(); }} />}
    <dialog ref={ref} aria-labelledby={titleId} aria-modal="true" tabIndex={-1} data-testid={testId} data-open={open ? "true" : "false"}
      onKeyDown={onKeyDown}
      className={cn("fixed z-[55] m-0 w-full overflow-y-auto overscroll-contain border border-white/15 bg-char p-0 text-cream shadow-2xl outline-none",
        "portfolio-action-dialog max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:max-h-[calc(100dvh-2.5rem)] max-sm:max-w-none max-sm:rounded-t-3xl max-sm:border-b-0",
        "sm:left-1/2 sm:top-1/2 sm:max-h-[calc(100dvh-2rem)] sm:w-[calc(100%-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl", SIZES[size])}>
      <div className="p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))] sm:p-7">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="min-w-0 text-lg font-semibold text-cream">{title}</h2>
          {dismissible && <button type="button" aria-label="Close" onClick={onClose}
            className="-mr-1 -mt-1 shrink-0 rounded-full p-1.5 text-cream/70 transition-colors hover:bg-white/10 hover:text-cream"><X aria-hidden="true" className="size-5" /></button>}
        </div>
        {children}
      </div>
    </dialog>
  </>;
}
