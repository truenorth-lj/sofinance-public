import type { PoolDailyAprResult } from "@/lib/pool-daily-apr";
import type { PoolSource } from "@/lib/pool-sources/types";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import type { DexAdapter } from "./adapter";
import { feePolicyProblems } from "./fees";
import { normalizeDexId, type DexCapabilities, type DexDescriptor, type DexId } from "./types";

/** One DEX as registered server-side: its descriptor, a lazy adapter (keeps SDKs out of other routes), its pool scan. */
export type DexModule = {
  descriptor: DexDescriptor;
  adapter?: () => Promise<DexAdapter>;
  poolSource?: PoolSource;
  /**
   * Daily fee APR series for one of this DEX's pools (same shape as the Raydium series of /api/pool-daily-apr), or
   * null when the pool is not this DEX's. Lazy, like the adapter.
   */
  poolDailyApr?: (poolId: string) => Promise<PoolDailyAprResult | null>;
};

/** Client-safe lookups over descriptors only. */
export type DexDescriptorRegistry = {
  readonly descriptors: readonly DexDescriptor[];
  /** Accepts canonical ids and one-release legacy aliases. */
  descriptorFor(id: string): DexDescriptor | null;
  /** Merged capabilities for a position: its DEX's, with that position's overrides on top; null for an unknown DEX. */
  capabilitiesFor(position: UnifiedPosition): DexCapabilities | null;
};

export type DexRegistry = DexDescriptorRegistry & {
  adapterFor(id: string): Promise<DexAdapter | null>;
  poolSources(): readonly PoolSource[];
  /**
   * The daily fee APR series from the registered DEX that lists this pool; null when none does (the caller keeps its
   * existing Raydium path for those pools).
   */
  poolDailyApr(poolId: string): Promise<PoolDailyAprResult | null>;
};

/** Problems with a set of descriptors (duplicate ids, an invalid fee policy, impossible open-step bounds). */
export function dexDescriptorProblems(descriptors: readonly DexDescriptor[]): string[] {
  const problems: string[] = [];
  const seen = new Set<DexId>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) problems.push(`${descriptor.id}: registered twice`);
    seen.add(descriptor.id);
    for (const problem of feePolicyProblems(descriptor.meta.feePolicy)) problems.push(`${descriptor.id}: ${problem}`);
    const { min, max } = descriptor.meta.openSteps;
    if (!(Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min)) problems.push(`${descriptor.id}: openSteps must be 1 <= min <= max`);
  }
  return problems;
}

export function dexModuleProblems(modules: readonly DexModule[]): string[] {
  const problems = dexDescriptorProblems(modules.map((entry) => entry.descriptor));
  for (const { descriptor, poolSource } of modules) {
    if (poolSource && poolSource.id !== descriptor.id) problems.push(`${descriptor.id}: pool source "${poolSource.id}" has a different id`);
  }
  return problems;
}

export function createDexDescriptorRegistry(descriptors: readonly DexDescriptor[]): DexDescriptorRegistry {
  const problems = dexDescriptorProblems(descriptors);
  if (problems.length) throw new Error(`Invalid DEX registry: ${problems.join("; ")}`);
  const byId = new Map<DexId, DexDescriptor>(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const descriptorFor = (id: string) => {
    const canonical = normalizeDexId(id);
    return canonical ? byId.get(canonical) ?? null : null;
  };
  return Object.freeze({
    descriptors: Object.freeze([...descriptors]),
    descriptorFor,
    capabilitiesFor(position: UnifiedPosition) {
      const descriptor = descriptorFor(position.source);
      if (!descriptor) return null;
      const override = descriptor.positionCapabilities?.(position);
      return override && Object.keys(override).length ? { ...descriptor.capabilities, ...override } : descriptor.capabilities;
    },
  });
}

export function createDexRegistry(modules: readonly DexModule[]): DexRegistry {
  const problems = dexModuleProblems(modules);
  if (problems.length) throw new Error(`Invalid DEX registry: ${problems.join("; ")}`);
  const lookups = createDexDescriptorRegistry(modules.map((entry) => entry.descriptor));
  const byId = new Map<DexId, DexModule>(modules.map((entry) => [entry.descriptor.id, entry]));
  const sources = Object.freeze(modules.flatMap((entry) => (entry.poolSource ? [entry.poolSource] : [])));
  return Object.freeze({
    ...lookups,
    async adapterFor(id: string) {
      const canonical = normalizeDexId(id);
      const entry = canonical ? byId.get(canonical) : undefined;
      return entry?.adapter ? entry.adapter() : null;
    },
    poolSources: () => sources,
    async poolDailyApr(poolId: string) {
      // A DEX that cannot tell whether it lists the pool (its pool list is down) throws; the others still get asked,
      // and the first such error is rethrown only when no DEX answered, so the caller never reads it as "unlisted".
      let failure: { error: unknown } | null = null;
      for (const entry of modules) {
        if (!entry.poolDailyApr) continue;
        try {
          const result = await entry.poolDailyApr(poolId);
          if (result) return result;
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
      return null;
    },
  });
}
