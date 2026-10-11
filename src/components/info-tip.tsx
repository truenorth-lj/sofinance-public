"use client";

import { useId, useState, type ReactNode, type SyntheticEvent } from "react";
import { Info } from "lucide-react";

const TIP_WIDTH = 256;
const EDGE = 8;

type Position = { left: number; top?: number; bottom?: number };

/**
 * Hover / focus help bubble used next to labels. The bubble is `position: fixed`, so scroll containers such
 * as the modal cannot clip it.
 */
export function InfoTip({
  label, children, placement = "below", tone = "dark",
}: {
  label: string;
  children: ReactNode;
  placement?: "below" | "above";
  /** Surface the trigger sits on: `light` for cream / coloured cards. The bubble itself is always dark. */
  tone?: "dark" | "light";
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
        className={`inline-flex shrink-0 rounded focus-visible:outline-2 focus-visible:outline-offset-2 ${tone === "light"
          ? "text-ink/50 hover:text-ink focus-visible:outline-ink/70"
          : "text-smoke hover:text-cream/90 focus-visible:outline-cream/70"}`}
      >
        <Info size={24} strokeWidth={2} className="preview-icon h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {position && (
        <span
          id={id}
          role="tooltip"
          style={{ position: "fixed", left: position.left, top: position.top, bottom: position.bottom, width: TIP_WIDTH }}
          className="pointer-events-none z-[60] max-w-[calc(100vw-16px)] whitespace-normal rounded-lg border border-white/20 bg-char px-3 py-2 text-left font-display text-xs font-normal normal-case leading-5 tracking-normal text-cream/90 shadow-xl"
        >
          {children}
        </span>
      )}
    </span>
  );
}
