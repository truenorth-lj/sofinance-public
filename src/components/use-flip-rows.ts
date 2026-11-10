"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

const DURATION_MS = 220;
const EASING = "cubic-bezier(0.2, 0.7, 0.2, 1)";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
const canAnimate = (element: Element): element is HTMLElement => typeof (element as HTMLElement).animate === "function";

type Snapshot = { order: string; tops: Map<string, number>; height: number };

/**
 * Keeps a keyed list's changes followable (FLIP): when the rows under `container` that match `selector` change order or
 * membership (search, sort, a re-rank once estimates load), each row that stays slides from its old place to its new
 * one, a row that is new rises into place (no fade), and `container` eases from its old height to the new one, so what
 * sits below glides instead of jumping. Rows are keyed by their `data-pool` attribute. Nothing moves on the first
 * render, when only other content changed, or with reduced motion.
 *
 * Positions are layout positions (`offsetTop`, which ignores transforms), so a change that lands while rows are still
 * moving starts from their places rather than compounding the offsets in flight; a row's previous move is cancelled
 * before its next one starts.
 */
export function useFlipRows(container: RefObject<HTMLElement | null>, selector: string) {
  const last = useRef<Snapshot | null>(null);
  const running = useRef(new WeakMap<Element, Animation>());
  // No dependency list: measure after every commit, so the next change animates from where rows really were.
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const rows = [...root.querySelectorAll(selector)].filter(canAnimate);
    const tops = new Map(rows.map((row) => [row.getAttribute("data-pool") ?? "", row.offsetTop]));
    const order = [...tops.keys()].join("|");
    const height = root.offsetHeight;
    const previous = last.current;
    last.current = { order, tops, height };
    if (!previous || previous.order === order || reducedMotion()) return;

    const move = (element: HTMLElement, keyframes: Keyframe[]) => {
      running.current.get(element)?.cancel();
      running.current.set(element, element.animate(keyframes, { duration: DURATION_MS, easing: EASING }));
    };
    for (const row of rows) {
      const key = row.getAttribute("data-pool") ?? "";
      const before = previous.tops.get(key);
      // A new row rises into its slot. Movement only, no fade: if the animation never runs (a frozen background
      // page), the row is still visible, just a few pixels low.
      if (before === undefined) {
        move(row, [{ transform: "translateY(10px)" }, { transform: "none" }]);
        continue;
      }
      const shift = before - row.offsetTop;
      if (Math.abs(shift) > 0.5) move(row, [{ transform: `translateY(${shift}px)` }, { transform: "none" }]);
    }
    // `overflow: hidden` only while the height eases (a discrete keyframe value), so rising rows are clipped to the box.
    if (canAnimate(root) && Math.abs(previous.height - height) > 0.5) {
      move(root, [{ height: `${previous.height}px`, overflow: "hidden" }, { height: `${height}px`, overflow: "hidden" }]);
    }
  });
}
