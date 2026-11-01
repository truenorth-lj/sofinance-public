import type { Connection } from "@solana/web3.js";
import type { PoolProtocolId } from "@sofinance/engine/protocols/types";
import type { FetchPoolRangeAprOptions, PoolEconomicsSource, VolumeProfile } from "../pool-range-apr";
import type { PoolRangeAprPayload } from "../range-apr/types";
import type { OnchainPoolLiquidity } from "../range-apr/onchain-liquidity";
import type { PresetTickRange } from "../range-apr/preset-ranges";
import type { ThrottleGate } from "../range-apr/throttle-gate";
import type { DiscoverRwaPairsOptions, DiscoverRwaPairsResult, RwaPairRow } from "../rwa-pairs";
import type { IconSources } from "../token-icons/resolve";

/**
 * One concentrated-liquidity protocol the RWA pool scan reads (SCAN_DESIGN.md §2). The cron's discovery and APR jobs
 * only talk to a pool through its source, so another protocol plugs in by adding one module beside `raydium.ts` and
 * registering it in `registry.ts`. Robinhood Chain keeps its own roster path (`rhc-apr-refresh.ts`).
 */
export interface PoolSource {
  id: PoolProtocolId;
  chain: "solana";
  /** `rwa_feed_state.feed_key` the source's discovery publishes under. */
  feedKey: string;
  /** Badge label (same text as `PROTOCOL_LABELS`). */
  displayName: string;
  /** Pool candidates already through the shared RWA rules (not yet published). */
  discover(options: DiscoverRwaPairsOptions): Promise<DiscoverRwaPairsResult>;
  /** Economics (TVL, fee rate, token amounts, fee cuts) for the range-APR model. */
  economics: PoolEconomicsSource;
  /** Economics plus 24h/7d volume and the hourly price path (`VolumeProfile`). */
  loadProfile(poolId: string, fetcher: typeof fetch, nowSeconds: number, upstream: PoolSourceUpstream): Promise<VolumeProfile>;
  /** On-chain liquidity around the current price (tick arrays / bin arrays), as one `OnchainPoolLiquidity`. */
  readLiquidity(poolId: string, connection: Connection, pair?: PoolPairRef): Promise<OnchainPoolLiquidity>;
  /** Candidate ranges priced by the model; undefined = the Solana CLMM presets (`resolvePresetRanges`). */
  presets?(chain: OnchainPoolLiquidity): readonly PresetTickRange[];
  /** Payload assembly; undefined = the shared `assemblePoolRangeApr` with `presets`. */
  assemble?(poolId: string, profile: VolumeProfile, chain: OnchainPoolLiquidity, nowSeconds: number): PoolRangeAprPayload;
  /** An upstream rate limit of the source's own (not GeckoTerminal's): the pool saves nothing and its lane stops. */
  isThrottleError?(error: unknown): boolean;
  /** Token icon lookups, in priority order. */
  iconSources(fetcher?: typeof fetch): IconSources;
}

export type PoolSourceUpstream = {
  retry?: FetchPoolRangeAprOptions["retry"];
  /** The run's GeckoTerminal gate (sources whose history comes from GeckoTerminal). */
  gate?: ThrottleGate;
  /** The stored row (sources that read a pool by its own spec, e.g. a bin step). */
  pair?: PoolPairRef;
};

/** What a source may read from the stored row of a pool. */
export type PoolPairRef = Pick<RwaPairRow, "poolAddress" | "mintA" | "mintB" | "binStep" | "poolCreatedAt">;
