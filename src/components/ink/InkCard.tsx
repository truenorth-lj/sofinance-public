import type { ReactNode } from "react";
import { INK_COLORS } from "./ink-tokens";

interface InkCardProps {
  children: ReactNode;
  className?: string;
  padding?: "default" | "large";
  "aria-labelledby"?: string;
}

export function InkCard({ 
  children, 
  className = "", 
  padding = "default",
  "aria-labelledby": ariaLabelledBy
}: InkCardProps) {
  const paddingClass = padding === "large" ? "p-6 sm:p-8" : "p-5 sm:p-7";
  
  return (
    <section
      className={`rounded-[${INK_COLORS.radii?.card ?? "20px"}] border border-${INK_COLORS.cardBorder}/80 bg-[${INK_COLORS.cardBg}] ${paddingClass} ${className}`}
      aria-labelledby={ariaLabelledBy}
    >
      {children}
    </section>
  );
}
