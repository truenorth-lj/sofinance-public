import { uiFor } from "./ui";
import type { DexId } from "./types";

export type RangeAprProtocol = DexId;
export type RangeAprOptions = { rwaList?: boolean };
export type RangeAprClientPolicy = Readonly<{ route: "pool" | "protocol"; cacheScope: "pool" | "protocol"; rwaListRoute?: "pool"; rangeLabels?: Readonly<Record<string, string>> }>;
const DEFAULT_POLICY: RangeAprClientPolicy = Object.freeze({ route: "protocol", cacheScope: "protocol" });

/** Resolve URL and cache identity together before the browser's concurrency queue can yield. */
export function rangeAprRequestTarget(poolId: string, protocol: RangeAprProtocol, options?: RangeAprOptions): { url: string; cacheKey: string } {
  const policy = uiFor(protocol).rangeApr ?? DEFAULT_POLICY;
  const rwaList = policy.rwaListRoute === "pool" && options?.rwaList === true;
  const route = rwaList ? policy.rwaListRoute : policy.route;
  return {
    url: route === "pool" ? `/api/pool-range-apr?poolId=${encodeURIComponent(poolId)}`
      : `/api/protocol-pools/range-apr?protocol=${protocol}&poolId=${encodeURIComponent(poolId)}`,
    cacheKey: policy.cacheScope === "pool" ? poolId : `${protocol}${rwaList ? "-rwa" : ""}:${poolId}`,
  };
}
