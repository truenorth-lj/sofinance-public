"use client";

import { useEffect, useMemo, useState } from "react";
import { dexDescriptors, dexPositionLabel, dexPositionRangeText, fetchDexPositions, positionDescriptorsFor,
  type DexCapabilities, type DexDescriptor, type DexSigner } from "@/lib/dex/client";
import type { PositionLabelMetadata } from "@/lib/position-label";
import type { PositionSourceId, UnifiedPosition } from "@/lib/unified-positions/model";

/**
 * My positions from DEXes served through the registry (PR5): every descriptor whose signer is the connected wallet's,
 * except the sources the page already reads another way (`exclude`, today the inline Raydium scan). The panel renders
 * these rows, their header and details only from the unified shape and the descriptor; it never checks a DEX id.
 */
export type RegistryPositions = {
  /** DEXes this deployment serves for the wallet (a 404 drops a DEX). */
  sourceIds: readonly PositionSourceId[];
  /** Display names of served DEXes being re-read (a rescan or a new wallet after one served). Never named before a DEX
   * has answered once, so a deployment that does not serve it shows nothing about it. */
  loadingNames: string[];
  positions: UnifiedPosition[];
  /** Plain per-DEX failures (one DEX failing never hides another's positions). */
  errors: string[];
  owns(position: UnifiedPosition | null | undefined): boolean;
  /** What the panel offers for a row: the descriptor's capabilities, minus the tools the registry panel has no UI for. */
  capabilities(position: UnifiedPosition): DexCapabilities | null;
  /** The row's DEX descriptor (tools read meta from it: rent, fee policy, deposit inputs). */
  descriptor(position: UnifiedPosition): DexDescriptor | null;
  /** The `{ displayName, label }` pair `positionOptionLabel` (rows.ts) needs for a registry row. */
  optionSource(position: UnifiedPosition, metadata?: PositionLabelMetadata): { displayName: string; label: (position: UnifiedPosition) => string };
};

type Loaded = { owner: string; refresh: number; served: PositionSourceId[]; positions: UnifiedPosition[]; errors: string[] };

export function useRegistryPositions({ owner, signer, exclude, refresh }: {
  owner: string | null; signer: DexSigner; exclude: readonly string[]; refresh: number;
}): RegistryPositions {
  const excludeKey = exclude.join(",");
  const descriptors = useMemo(() => positionDescriptorsFor(dexDescriptors.descriptors, signer, excludeKey ? excludeKey.split(",") : []), [signer, excludeKey]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (!owner || !descriptors.length) return;
    const controller = new AbortController();
    void Promise.all(descriptors.map((descriptor) => fetchDexPositions(descriptor, owner, { signal: controller.signal })
      .then((positions) => ({ id: descriptor.id, served: positions !== null, positions: positions ?? [], error: null as string | null }))
      .catch((error: unknown) => ({ id: descriptor.id, served: true, positions: [] as UnifiedPosition[], error: controller.signal.aborted ? null : `${descriptor.displayName}: ${error instanceof Error ? error.message : "positions could not be loaded."}` }))))
      .then((results) => {
        if (controller.signal.aborted) return;
        setLoaded({ owner, refresh, served: results.filter((result) => result.served).map((result) => result.id), positions: results.flatMap((result) => result.positions), errors: results.flatMap((result) => (result.error ? [result.error] : [])) });
      });
    return () => controller.abort();
  }, [owner, refresh, descriptors]);
  const current = loaded && owner && loaded.owner === owner ? loaded : null;
  const loading = Boolean(owner && descriptors.length && (!current || current.refresh !== refresh));
  const byId = (position: UnifiedPosition | null | undefined): DexDescriptor | null =>
    position ? descriptors.find((descriptor) => descriptor.id === position.source) ?? null : null;
  return {
    sourceIds: current?.served ?? [],
    loadingNames: loading ? descriptors.filter((descriptor) => loaded?.served.includes(descriptor.id)).map((descriptor) => descriptor.displayName) : [],
    positions: current?.positions ?? [],
    errors: current?.errors ?? [],
    owns: (position) => Boolean(byId(position)),
    // Every tab follows the descriptor: Add / Withdraw / Claim (PR7), Compound (PR8) and Performance (PR9) all have a
    // registry panel (`registry-tools.tsx`); an unsupported one is greyed with its reason. No DEX id is checked.
    capabilities: (position) => (byId(position) ? dexDescriptors.capabilitiesFor(position) : null),
    descriptor: (position) => byId(position),
    optionSource: (position, metadata) => ({ displayName: byId(position)?.displayName ?? "", label: (item) => dexPositionLabel(item, metadata) }),
  };
}

/**
 * Under the selected registry position's row: its range (price or ticks). The range status badge and the per-token
 * Liquidity / Unclaimed fees rows were dropped (LJ 11/14): the row above already shows its shares, value and fees.
 */
export function RegistryPositionHeader({ position }: { position: UnifiedPosition }) {
  return <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="registry-position-header">
    <span className="rounded-full border border-white/20 bg-white/[0.05] px-2.5 py-1 text-cream/80">{dexPositionRangeText(position).replace(/^range/, "Range").replace(/^ticks/, "Ticks")}</span>
  </div>;
}

/** "Learn more details" lines for a selected registry position: the pool only (no position key or mints). */
export function RegistryPositionDetails({ position }: { position: UnifiedPosition }) {
  return <p>Pool: {position.poolId}</p>;
}
