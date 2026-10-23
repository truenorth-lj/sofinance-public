import "@/lib/engine-host";
import "server-only";

import { QUOTE_TTL_MS } from "@sofinance/engine/ids";
import { readOpenPoolState, type OpenPoolState, type OpenPositionSelection } from "@sofinance/engine/open-state";

const MAX_SNAPSHOTS = 32;
const snapshots = new Map<string, OpenPoolState>();

export function openPoolSnapshotKey(wallet: string, selection: OpenPositionSelection) {
  return `${wallet}:${selection.poolId}:${selection.inputMint}:${selection.inputKind}`;
}

export function clearOpenPoolSnapshots() {
  snapshots.clear();
}

/**
 * Reuses the pool/wallet snapshot across Jupiter-relay 409 rounds of one preview.
 * The engine already treats a snapshot as valid for `QUOTE_TTL_MS`; without this,
 * every relay round re-reads the pool, tick arrays and wallet (and burns RPC).
 */
export async function cachedOpenPoolState(
  wallet: string,
  selection: OpenPositionSelection,
): Promise<OpenPoolState> {
  const key = openPoolSnapshotKey(wallet, selection);
  const hit = snapshots.get(key);
  if (hit && Date.now() < hit.fetchedAt + QUOTE_TTL_MS) return hit;
  const state = await readOpenPoolState(wallet, selection);
  snapshots.delete(key);
  snapshots.set(key, state);
  while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
  return state;
}
