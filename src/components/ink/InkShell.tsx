import type { ReactNode } from "react";

interface InkShellProps {
  children: ReactNode;
  maxWidth?: "3xl" | "5xl";
}

export function InkShell({ children, maxWidth = "5xl" }: InkShellProps) {
  const maxWidthClass = maxWidth === "3xl" ? "max-w-3xl" : "max-w-[1280px]";

  return (
    <div className="min-h-screen bg-canvas text-cream">
      <div className={`relative mx-auto ${maxWidthClass} px-3 pb-24 pt-3 sm:px-5 sm:pt-5`}>{children}</div>
    </div>
  );
}
