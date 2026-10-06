import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes } from "react";

export function Button({ className, variant = "primary", asChild = false, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary"; asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return <Component className={cn("inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-45", variant === "primary" ? "bg-sky-400 text-slate-950 hover:bg-sky-300" : "border border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700", className)} {...props} />;
}
