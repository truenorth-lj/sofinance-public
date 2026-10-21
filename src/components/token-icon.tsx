"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

export function TokenIcon({ symbol, icon, className }: { symbol: string; icon: string | null; className?: string }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  return <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/12 bg-white/[0.06] text-sm font-bold text-cream", className)}>
    {icon && failedIcon !== icon ? <>
      {/* Icons come from a bounded list of HTTPS hosts validated by the server. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={icon} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailedIcon(icon)} className="h-full w-full object-cover" />
    </> : symbol.slice(0, 2).toUpperCase()}
  </span>;
}
