import { compoundAllFlowFor, type CompoundAllRowInput } from "./state";
import type { DexDescriptor } from "@/lib/dex/types";
import type { PositionHoldings, RangeStatus, TokenPairRaw, UnifiedPosition } from "@/lib/unified-positions/model";
import { isClosed } from "@/lib/unified-positions/rows";

/** What Portfolio knows about one position when the Compound all checklist opens. */
export type CompoundAllCandidate = {
  position: Pick<UnifiedPosition, "key" | "source" | "nativeId" | "rangeStatus" | "liquidity">;
  /** The position's own Compound capability (a DEX can support compound and still not for this pool). */
  compoundSupported: boolean;
  unclaimedFeesUsd: number | null;
  /** Registry DEXes read the raw unclaimed fees too; `null` = not read. */
  unclaimedFeesRaw?: TokenPairRaw | null;
};

/** Raw unclaimed fees for one position: the source's own holdings first, else the Portfolio read of the same position. */
export const unclaimedFeesRawFor = (holdings: PositionHoldings | undefined, portfolioRaw: TokenPairRaw | undefined): TokenPairRaw | null =>
  holdings?.unclaimedFeesRaw ?? portfolioRaw ?? null;

const positive = (raw: string) => { try { return BigInt(raw) > 0n; } catch { return false; } };

/** Unclaimed fees known to be above zero (a figure that could not be read is not "has fees"). */
export function hasUnclaimedFees(candidate: Pick<CompoundAllCandidate, "unclaimedFeesUsd" | "unclaimedFeesRaw">) {
  if (candidate.unclaimedFeesRaw && (positive(candidate.unclaimedFeesRaw.a) || positive(candidate.unclaimedFeesRaw.b))) return true;
  return typeof candidate.unclaimedFeesUsd === "number" && candidate.unclaimedFeesUsd > 0;
}

const outOfRange = (status: RangeStatus) => status === "below" || status === "above";

/**
 * The checklist rows: open positions whose DEX compound all can run and that still have fees to compound, in Portfolio
 * order. A position with no fees (or fees that could not be read) is not listed.
 */
export function compoundAllRows(candidates: readonly CompoundAllCandidate[],
  descriptorFor: (dex: string) => Pick<DexDescriptor, "id" | "capabilities" | "nativeCapabilities"> | null): CompoundAllRowInput[] {
  return candidates.flatMap(({ position, compoundSupported, ...fees }): CompoundAllRowInput[] => {
    if (isClosed(position) || !compoundSupported || !hasUnclaimedFees(fees)) return [];
    const descriptor = descriptorFor(position.source);
    const flow = compoundAllFlowFor(descriptor);
    if (!descriptor || !flow) return [];
    return [{ key: position.key, dex: descriptor.id, flow, positionId: position.nativeId, outOfRange: outOfRange(position.rangeStatus) }];
  });
}
