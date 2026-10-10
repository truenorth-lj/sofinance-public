import type { ReactNode } from "react";

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
  "aria-labelledby": ariaLabelledBy,
}: InkCardProps) {
  const paddingClass = padding === "large" ? "p-6 sm:p-9" : "p-6 sm:p-7";

  return (
    <section
      className={`rounded-[28px] border border-white/12 bg-char ${paddingClass} ${className}`}
      aria-labelledby={ariaLabelledBy}
    >
      {children}
    </section>
  );
}
