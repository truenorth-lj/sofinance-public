"use client";

import { useSearchParams } from "next/navigation";
import { queryFromSearchParams } from "../lib/position-performance-form";
import { PositionPerformancePanel } from "./position-performance-panel";

export function PositionPerformancePanelFallback() {
  return (
    <section
      className="rounded-[20px] border border-neutral-800/80 bg-[#0a0a0a] p-5 sm:p-7"
      aria-hidden
    >
      <div className="h-5 w-48 rounded bg-neutral-800/80" />
      <div className="mt-4 space-y-3">
        <div className="h-10 rounded-xl bg-neutral-900" />
        <div className="h-10 rounded-xl bg-neutral-900" />
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
