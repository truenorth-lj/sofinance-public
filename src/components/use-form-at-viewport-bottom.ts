"use client";

import { useEffect, useState } from "react";

/**
 * True once the top of the element `id` (the Add form) is on screen above the bottom `reserve` px (≥ the bar's height).
 * The phone's sticky Add liquidity bar (the form's only Add button on a phone) shows only then. The form sits below the
 * positions list, so the bar can then cover only the form or what follows it, never the list: not on load, and not
 * before the user opens Add to position or scrolls to the form.
 */
export function useFormAtViewportBottom(id: string, enabled: boolean, reserve = 120): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const element = document.getElementById(id);
      const rect = element && !element.hidden ? element.getBoundingClientRect() : null;
      const bottom = window.innerHeight;
      setOver(rect !== null && rect.height > 0 && rect.top <= bottom - reserve);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(check); };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // The list and the form change height as positions and quotes load.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(document.body);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      resize?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [id, enabled, reserve]);
  return enabled && over;
}
