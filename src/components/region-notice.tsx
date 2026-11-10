"use client";

import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import {
  hasRegionNoticeCookie,
  isRegionNoticePath,
  REGION_NOTICE_DISMISS_KEY,
  REGION_NOTICE_LINK_TEXT,
  REGION_NOTICE_TEXT,
  XSTOCKS_ELIGIBILITY_TERMS_URL,
} from "@/lib/region-notice";
import { EXTERNAL_LINK_PROPS } from "@/lib/social-links";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function dismissed() {
  try { return window.localStorage.getItem(REGION_NOTICE_DISMISS_KEY) === "1"; } catch { return false; }
}

const [beforeLink, afterLink] = REGION_NOTICE_TEXT.split(REGION_NOTICE_LINK_TEXT);

/**
 * Small, dismissible notice for visitors flagged by the Proxy (see src/lib/region-notice.ts).
 * Shown only on /app and /app/rwa-pairs. Informational only: not a dialog, no overlay, and it
 * never gates connect / open / withdraw.
 */
export function RegionNotice({ forceShow = false }: { forceShow?: boolean } = {}) {
  const pathname = usePathname();
  const show = useSyncExternalStore(
    subscribe,
    () => !dismissed() && (forceShow || hasRegionNoticeCookie(document.cookie)),
    () => false,
  );
  if (!isRegionNoticePath(pathname) || !show) return null;

  const dismiss = () => {
    try { window.localStorage.setItem(REGION_NOTICE_DISMISS_KEY, "1"); } catch { /* storage unavailable: hide for this view */ }
    listeners.forEach((listener) => listener());
  };

  return <div role="note" aria-label="Regional notice" className="border-b border-white/10 bg-char text-smoke">
    <div className="mx-auto flex max-w-5xl items-start gap-3 px-4 py-2 text-xs leading-5 sm:items-center">
      <p className="flex-1">
        {beforeLink}
        <a
          href={XSTOCKS_ELIGIBILITY_TERMS_URL}
          className="text-cream underline underline-offset-2 hover:text-lemon"
          {...EXTERNAL_LINK_PROPS}
        >
          {REGION_NOTICE_LINK_TEXT}
        </a>
        {afterLink}
      </p>
      <button type="button" onClick={dismiss} aria-label="Dismiss notice" className="shrink-0 rounded-full px-2 text-base leading-5 text-smoke hover:text-cream">×</button>
    </div>
  </div>;
}
