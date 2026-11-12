/**
 * Shared RHC position list order: wallet holdings first (scan order, newest NFT first),
 * then local / hand-added ids the scan did not find, deduped by NFT id.
 */
export function mergeRhcPositionLookups<S extends { tokenId: string }, L extends { tokenId: string }>(
  scanned: readonly S[],
  lookups: readonly L[],
): { rows: Array<S | L>; scannedById: Map<string, S> } {
  const scannedById = new Map(scanned.map((s) => [s.tokenId, s] as const));
  return { rows: [...scanned, ...lookups.filter((l) => !scannedById.has(l.tokenId))], scannedById };
}
