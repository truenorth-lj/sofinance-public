import { Geist } from "next/font/google";
import type { ReactNode } from "react";
import { INK_COLORS } from "./ink-tokens";

const geist = Geist({ subsets: ["latin"] });

interface InkShellProps {
  children: ReactNode;
  maxWidth?: "3xl" | "5xl";
}

export function InkShell({ children, maxWidth = "5xl" }: InkShellProps) {
  const maxWidthClass = maxWidth === "3xl" ? "max-w-3xl" : "max-w-5xl";
  
  return (
    <div className={`min-h-screen bg-[${INK_COLORS.canvas}] text-${INK_COLORS.textPrimary} ${geist.className}`}>
      <div className={`relative mx-auto ${maxWidthClass} px-5 pb-24 pt-6 sm:px-8 sm:pt-10`}>
        {children}
      </div>
    </div>
  );
}
