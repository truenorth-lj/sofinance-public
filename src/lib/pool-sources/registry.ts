import type { PoolProtocolId } from "@sofinance/engine/protocols/types";
import { raydiumPoolSource } from "./raydium";
import type { PoolSource } from "./types";

/** Every Solana pool source the RWA scan knows, in discovery order. Add a protocol here (SCAN_DESIGN.md §9). */
export const POOL_SOURCES: readonly PoolSource[] = Object.freeze([raydiumPoolSource]);

/** Sources whose discovery runs in the cron (all registered ones; a new source gates itself with a code flag). */
export function scanPoolSources(): readonly PoolSource[] {
  return POOL_SOURCES;
}

/**
 * The source that refreshes a stored pool. Rows saved before `protocol` was set (or with a protocol no source
 * handles yet) keep today's behavior: the Raydium path, which is what the cron ran for every Solana pool.
 */
export function poolSourceFor(protocol: PoolProtocolId | undefined): PoolSource {
  return POOL_SOURCES.find((source) => source.id === protocol) ?? raydiumPoolSource;
}
