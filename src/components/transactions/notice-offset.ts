"use client";

import { useEffect, type RefObject } from "react";

/** CSS variable the toast stack (`TxNoticeHost`) adds to its bottom offset on phones. */
export const NOTICE_BOTTOM_OFFSET_VAR = "--tx-notice-bottom-offset";

/**
 * Keep transaction toasts above a fixed bottom action bar: publishes the bar's height (0 while it is hidden, e.g.
 * `sm:hidden` on wider screens) so a toast never covers the bar's button at 375 px.
 */
export function useNoticeBottomOffset(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const element = ref.current;
    const root = document.documentElement;
    if (!active || !element) return;
    const update = () => root.style.setProperty(NOTICE_BOTTOM_OFFSET_VAR, `${Math.ceil(element.getBoundingClientRect().height)}px`);
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
      root.style.removeProperty(NOTICE_BOTTOM_OFFSET_VAR);
    };
  }, [ref, active]);
}
