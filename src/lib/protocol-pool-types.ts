/** Runtime-free DTO facade; protocol readers own the HTTP field types. */
import type { OrcaPairsResult } from "./orca-pairs";
import type { MeteoraPairsResult } from "./meteora-pairs";
import type { RhcUniv4PoolsResult } from "./rhc-univ4-pools";
import type { OrcaRangeAprPayload } from "./orca-range-apr";
import type { MeteoraRangeAprPayload } from "./meteora-range-apr";
import type { getRhcAprSnapshot } from "./rhc-snapshot";
export type ProtocolPoolListing = OrcaPairsResult | MeteoraPairsResult | RhcUniv4PoolsResult;
export type ProtocolPoolRangeApr = OrcaRangeAprPayload | MeteoraRangeAprPayload | Awaited<ReturnType<typeof getRhcAprSnapshot>>;
