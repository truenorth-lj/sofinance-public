"use client";

import { regionNoticeDismissSetCookie } from "@/lib/region-notice";

/**
 * Dismiss control only. The notice markup is server-rendered so it is in the initial HTML;
 * this button writes the dismiss cookie and removes the banner for this view.
 */
export function RegionNoticeDismissButton() {
  return (
    <button
      type="button"
      aria-label="Dismiss notice"
      className="shrink-0 rounded-full px-2 text-base leading-5 text-smoke hover:text-cream"
      onClick={(event) => {
        document.cookie = regionNoticeDismissSetCookie(window.location.protocol === "https:");
        event.currentTarget.closest("[role=note]")?.remove();
      }}
    >
      ×
    </button>
  );
}
