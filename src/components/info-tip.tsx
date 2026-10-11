"use client";

import { useId, useState, type ReactNode, type SyntheticEvent } from "react";
import { Info } from "lucide-react";

const TIP_WIDTH = 256;
const EDGE = 8;

type Position = { left: number; top?: number; bottom?: number };

/**
 * Hover / focus help bubble used next to labels. The bubble is `position: fixed`, so scroll containers such
 * as the pairs table (`overflow-x-auto`) or the modal cannot clip it.
 */
export function InfoTip({
  label, children, placement = "below",
}: {
  label: string;
  children: ReactNode;
  placement?: "below" | "above";
}) {
  const id = useId();
  const [position, setPosition] = useState<Position | null>(null);
  const show = (event: SyntheticEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - TIP_WIDTH - EDGE));
    setPosition(placement === "below"
      ? { left, top: rect.bottom + 4 }
      : { left, bottom: window.innerHeight - rect.top + 4 });
  };
  const hide = () => setPosition(null);
  return (
    <span className="inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={position ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(event) => { if (event.key === "Escape") hide(); }}
        className="inline-flex shrink-0 rounded text-smoke hover:text-cream/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream/70"
      >
        <Info size={24} strokeWidth={2} className="preview-icon h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {position && (
        <span
          id={id}
          role="tooltip"
          style={{ position: "fixed", left: position.left, top: position.top, bottom: position.bottom, width: TIP_WIDTH }}
          className="pointer-events-none z-[60] max-w-[calc(100vw-16px)] whitespace-normal rounded-lg border border-white/20 bg-char px-3 py-2 text-left text-xs font-normal leading-5 text-cream/90 shadow-xl"
        >
          {children}
        </span>
      )}
    </span>
  );
}
