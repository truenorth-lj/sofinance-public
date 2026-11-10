"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import Link from "next/link";
import { DOCS_ROUTES } from "@/lib/public-urls";

/** Shared Create-position sheet. Visual contract is Raydium's OpenPositionModal. */
export function OpenPositionChrome({
  title = "Create position",
  subtitle,
  explainer,
  labelledBy,
  closeAriaLabel = "Close create position",
  closeLocked = false,
  onClose,
  wide = false,
  showRisksLink = true,
  children,
}: {
  title?: string;
  subtitle?: ReactNode;
  explainer?: ReactNode;
  labelledBy: string;
  closeAriaLabel?: string;
  closeLocked?: boolean;
  onClose: () => void;
  wide?: boolean;
  showRisksLink?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !closeLocked) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeLocked, onClose]);
  const requestClose = () => { if (!closeLocked) onClose(); };
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <button type="button" className="absolute inset-0 bg-black/70" aria-label={closeAriaLabel} onClick={requestClose} disabled={closeLocked} />
      <div className={`relative z-10 max-h-[92vh] w-full overflow-y-auto rounded-t-[20px] border border-white/12 bg-char p-5 text-cream sm:rounded-[28px] sm:p-6 ${wide ? "max-w-2xl" : "max-w-lg"}`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id={labelledBy} className="text-base font-semibold text-cream">{title}</h2>
            {subtitle ? <p className="mt-1 text-xs leading-5 text-smoke">{subtitle}</p> : null}
            {explainer ? <p className="mt-2 text-xs leading-5 text-smoke">{explainer}</p> : null}
          </div>
          <button type="button" onClick={requestClose} disabled={closeLocked} title={closeLocked ? "Wait until the transaction is sent" : undefined}
            className="rounded-lg p-1 text-smoke hover:text-cream/90 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        {showRisksLink ? (
          <div className="mb-4 flex flex-wrap items-center gap-1">
            <Link href={DOCS_ROUTES.risks} className="text-[11px] text-lemon underline underline-offset-2 hover:text-[#fff27f]">
              Read risks before you confirm
            </Link>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export const OPEN_POSITION_SUBMIT =
  "mt-4 w-full rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40";
