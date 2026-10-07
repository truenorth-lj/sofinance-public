import type { ButtonHTMLAttributes, ReactNode } from "react";
import { INK_COLORS } from "./ink-tokens";

interface InkButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "ghost" | "primary";
  size?: "sm" | "md";
}

export function InkButton({ 
  children, 
  className = "", 
  variant = "ghost",
  size = "md",
  ...props 
}: InkButtonProps) {
  const sizeClass = size === "sm" ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm";
  
  const variantClass = variant === "primary" 
    ? `bg-${INK_COLORS.textPrimary} text-[${INK_COLORS.canvas}] hover:bg-${INK_COLORS.textSecondary}`
    : `border border-${INK_COLORS.buttonBorder} bg-transparent text-${INK_COLORS.textSecondary} hover:border-${INK_COLORS.buttonBorderHover} hover:bg-${INK_COLORS.buttonBgHover}`;
  
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${sizeClass} ${variantClass} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
