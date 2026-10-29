"use client";

import { useSyncExternalStore } from "react";
import { hasRegionNoticeCookie, REGION_NOTICE_DISMISS_KEY, REGION_NOTICE_TEXT } from "@/lib/region-notice";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function dismissed() {
  try { return window.localStorage.getItem(REGION_NOTICE_DISMISS_KEY) === "1"; } catch { return false; }
}

const visible = () => hasRegionNoticeCookie(document.cookie) && !dismissed();

/**
 * Small, dismissible notice for visitors flagged by the Proxy (see src/lib/region-notice.ts).
 * Informational only: not a dialog, no overlay, and it never gates connect / open / withdraw.
 */
export function RegionNotice() {
  const show = useSyncExternalStore(subscribe, visible, () => false);
  if (!show) return null;

  const dismiss = () => {
    try { window.localStorage.setItem(REGION_NOTICE_DISMISS_KEY, "1"); } catch { /* storage unavailable: hide for this view */ }
    listeners.forEach((listener) => listener());
  };

  return <div role="note" aria-label="Regional notice" className="border-b border-white/10 bg-char text-smoke">
    <div className="mx-auto flex max-w-5xl items-start gap-3 px-4 py-2 text-xs leading-5 sm:items-center">
      <p className="flex-1">{REGION_NOTICE_TEXT}</p>
      <button type="button" onClick={dismiss} aria-label="Dismiss notice" className="shrink-0 rounded-full px-2 text-base leading-5 text-smoke hover:text-cream">×</button>
    </div>
  </div>;
}
