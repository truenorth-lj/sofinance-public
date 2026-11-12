"use client";

import { useEffect, useState } from "react";
import { fetchPositions, fetchScan, type Scan } from "./rhc-close";
import { mergeRhcPositionLookups } from "@/lib/unified-positions/rhc-list";

type Lookups = Awaited<ReturnType<typeof fetchPositions>>["lookups"];

/**
 * Shared load/scan/add state for the pools-page RHC positions panel and `/app` My positions.
 * Tracking storage (local NFT ids) stays with the caller so this hook does not import the wallet-exit module.
 */
export function useRhcPositionList({ address, refreshKey = 0, trackedIds }: {
  address: string | null;
  refreshKey?: number;
  trackedIds: (address: string) => string[];
}) {
  const [lookups, setLookups] = useState<Lookups>([]);
  const [scan, setScan] = useState<Scan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [addId, setAddId] = useState("");

  const load = async (ids?: string[]) => {
    if (!address) return;
    setLoading(true);
    const [r, s] = await Promise.all([fetchPositions(address, ids ?? trackedIds(address)), ids ? Promise.resolve(null) : fetchScan(address, true)]);
    setLookups(r.lookups); setLoadError(r.error); if (s) setScan(s); setLoading(false);
  };

  useEffect(() => {
    if (!address) return;
    let live = true;
    void fetchPositions(address, trackedIds(address)).then(r => { if (live) { setLookups(r.lookups); setLoadError(r.error); } });
    void fetchScan(address, refreshKey > 0).then(s => { if (live) setScan(s); });
    return () => { live = false; setScan(null); };
  }, [address, refreshKey, trackedIds]);

  const submitAdd = (track: (address: string, id: string) => string[]) => {
    if (!address) return;
    const id = addId.trim();
    if (!/^[0-9]{1,30}$/.test(id)) { setLoadError("Enter the position NFT number, for example 4077059."); return; }
    setAddId("");
    void load(track(address, id));
  };

  const submitRemove = (id: string, untrack: (address: string, id: string) => string[]) => {
    if (!address) return;
    void load(untrack(address, id));
  };

  const scanned = scan?.positions ?? [];
  const { rows, scannedById } = mergeRhcPositionLookups(scanned, lookups);
  return {
    lookups, scan, loadError, setLoadError, loading, addId, setAddId, load, submitAdd, submitRemove,
    scanned, scannedById, rows, scanning: scan === null,
  };
}
