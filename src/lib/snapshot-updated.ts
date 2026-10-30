import type { PoolChain } from "@/lib/unified-pools/model";

/** When one chain's saved pool list was written (its `fetchedAt`) and whether the server marked it stale. */
export type SnapshotSourceTime = { chain: PoolChain; fetchedAt: string; stale: boolean };

/** "2026-10-30 11:02 UTC" (minute precision); null for an unparsable or unset (epoch) time. */
export function utcMinuteLabel(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const CHAIN_NAMES: Readonly<Record<PoolChain, string>> = { solana: "Solana", robinhood: "Robinhood Chain" };

/**
 * "Updated 2026-10-30 11:02 UTC" from the saved lists' `fetchedAt` (absolute, so cached HTML never says "just now").
 * When the chains' lists were written in different minutes, each chain gets its own time. "Data delayed" when the
 * server marked a list stale.
 */
export function updatedLabel(sources: readonly SnapshotSourceTime[]): string | null {
  const times = sources.map((source) => ({ ...source, label: utcMinuteLabel(source.fetchedAt) }))
    .filter((source): source is SnapshotSourceTime & { label: string } => source.label !== null);
  if (!times.length) return null;
  const delayed = times.some((source) => source.stale) ? " · Data delayed" : "";
  if (new Set(times.map((source) => source.label)).size === 1) return `Updated ${times[0]!.label}${delayed}`;
  return `Updated ${times.map((source) => `${source.label} (${CHAIN_NAMES[source.chain]})`).join(" · ")}${delayed}`;
}
