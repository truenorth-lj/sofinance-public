import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes } from "react";

export function Button({ className, variant = "primary", asChild = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary"; asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return <Component className={cn("inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lemon disabled:cursor-not-allowed disabled:opacity-45", variant === "primary" ? "bg-lemon text-ink hover:bg-[#fff27f]" : "border border-white/25 bg-white/10 text-cream hover:bg-white/[0.14]", className)} {...props} />;
}
