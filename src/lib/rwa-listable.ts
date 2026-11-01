/**
 * Pools a user can be shown (list page, home top-5, MCP): drops rows the scan marked `blocked` (a paused,
 * transfer-fee or default-frozen Token-2022 mint). Blocked rows stay in the snapshot for audit. Pure, no I/O.
 */
export function listablePairs<T extends { blocked?: unknown }>(pairs: readonly T[]): T[] {
  return pairs.filter((pair) => !pair.blocked);
}
