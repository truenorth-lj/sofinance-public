"use client";

import { useSearchParams } from "next/navigation";
import { queryFromSearchParams } from "../lib/position-performance-form";
import { PositionPerformancePanel } from "./position-performance-panel";

export function PositionPerformancePanelFallback() {
  return (
    <section
      className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7 lg:col-span-5"
      aria-hidden
    >
      <div className="h-5 w-48 rounded bg-white/10" />
      <div className="mt-4 space-y-3">
        <div className="h-10 rounded-2xl bg-white/[0.06]" />
        <div className="h-10 rounded-2xl bg-white/[0.06]" />
      </div>
    </section>
  );
}

/** Reads `?mint=` / `?wallet=` from the browser URL so a static prerender cannot bake in `{}`. */
export function PositionPerformanceQueryPanel() {
  const searchParams = useSearchParams();
  const query = queryFromSearchParams(searchParams);
  const previewPoolId = (searchParams.get("pool") ?? "").trim();
  return (
    <PositionPerformancePanel
      key={`${query.mint}:${query.wallet}:${previewPoolId}`}
      initialMint={query.mint}
      initialWallet={query.wallet}
      previewPoolId={previewPoolId}
    />
  );
}
