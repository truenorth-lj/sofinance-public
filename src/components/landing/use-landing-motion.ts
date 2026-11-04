"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/** True when the visitor asked for reduced motion. `null` before mount (server HTML and first client render). */
export function useReducedMotion(): boolean | null {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => null);
}

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(REDUCE_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

const readReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia(REDUCE_QUERY).matches;

/** Whether `ref` is on screen (at `threshold` visible). Stays false without IntersectionObserver. */
export function useInView(ref: RefObject<Element | null>, threshold = 0.3): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) setInView(entry.isIntersecting);
    }, { threshold });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, threshold]);
  return inView;
}

/** Linear interpolation in sorted `[x, y]` points, clamped at both ends. */
export function interpolate(points: readonly (readonly [number, number])[], x: number): number {
  if (points.length === 0) return 0;
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    if (x1 >= x) {
      const [x0, y0] = points[i - 1]!;
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1]![1];
}

export const usd = (value: number) =>
  `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const signedPct = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
