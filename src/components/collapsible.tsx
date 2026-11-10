"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Shows or hides its content by animating the height (grid rows 0fr ↔ 1fr), so what sits below slides instead of
 * jumping. Hidden content stays mounted but is inert and out of the accessibility tree. No motion when the user asks
 * for reduced motion.
 */
export function Collapsible({ open, children, className, testId }: { open: boolean; children: ReactNode; className?: string; testId?: string }) {
  return <div data-testid={testId} data-open={open} inert={!open} aria-hidden={!open}
    className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
      open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0", className)}>
    <div className="min-h-0 overflow-hidden">{children}</div>
  </div>;
}
