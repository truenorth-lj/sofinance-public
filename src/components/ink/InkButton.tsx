import type { ButtonHTMLAttributes, ReactNode } from "react";

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
  const sizeClass = size === "sm" ? "h-9 px-4 text-xs" : "h-11 px-5 text-sm";
  const variantClass =
    variant === "primary"
      ? "bg-lemon text-ink hover:bg-[#fff27f]"
      : "border border-white/25 text-cream/85 hover:border-white/70";

  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-full font-semibold outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--color-lemon)] disabled:cursor-not-allowed disabled:opacity-40 ${sizeClass} ${variantClass} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
