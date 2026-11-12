"use client";

import type { ReactNode } from "react";

/**
 * Shared Add-NFT input and load/scan/error/empty status for both RHC position lists.
 * Heading, intro copy, and empty-message extras stay with the caller so each surface keeps its wording.
 */
export function RhcPositionsToolbar({ intro, addId, onAddId, onAdd, loading, scanning, scanError, loadError, empty }: {
  intro: ReactNode;
  addId: string;
  onAddId: (value: string) => void;
  onAdd: () => void;
  loading: boolean;
  scanning: boolean;
  scanError?: string | null;
  loadError: string | null;
  empty: ReactNode | null;
}) {
  return <>
    {intro}
    <div className="mt-2 flex flex-wrap gap-2">
      <input inputMode="numeric" value={addId} onChange={e => onAddId(e.target.value)} placeholder="Position NFT #" aria-label="Position NFT number"
        className="w-40 rounded-lg bg-black/30 p-2 text-base sm:text-sm text-cream" />
      <button type="button" onClick={onAdd} className="rounded-lg border border-white/25 px-3 py-1.5 text-xs font-semibold text-cream">Add</button>
    </div>
    {loading ? <p role="status" className="mt-2 text-xs text-smoke">Loading positions…</p> : null}
    {scanning && !loading ? <p role="status" className="mt-2 text-xs text-smoke" data-testid="positions-scanning">Checking this wallet&apos;s Robinhood Chain positions…</p> : null}
    {scanError ? <p className="mt-2 text-xs text-amber-200/90" data-testid="positions-scan-error">{scanError}</p> : null}
    {loadError ? <p className="mt-2 text-xs text-red-200" data-testid="positions-error">{loadError}</p> : null}
    {empty}
  </>;
}
