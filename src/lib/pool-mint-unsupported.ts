/** A pool whose mints carry settings opening does not handle yet: those settings and the mints that have them. */
export type PoolMintUnsupported = { issues: string[]; mints: string[] };

/**
 * The pool's unsupported mint settings (each mint's `unsupported`, from the engine's `poolMintIssues` in
 * `readMintSafety`), deduplicated, or undefined when both mints are fine or unread.
 */
export function unsupportedOf(mints: readonly [string, { unsupported?: readonly string[] } | undefined][]): PoolMintUnsupported | undefined {
  const hit = mints.filter(([, safety]) => safety?.unsupported?.length);
  if (!hit.length) return undefined;
  return { issues: [...new Set(hit.flatMap(([, safety]) => safety?.unsupported ?? []))], mints: [...new Set(hit.map(([mint]) => mint))] };
}
