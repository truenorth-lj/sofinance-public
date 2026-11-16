import type { RhcPoolSummary, RhcPoolView } from "@/lib/evm-client-types";
import type { UnifiedPool } from "@/lib/unified-pools/model";

/** Pure native EVM presentation. It never fetches, signs or enables an operation. */
export type NativeEvmPoolPresentation = {
  pairLabel: (poolId: string, separator?: string) => string | null;
  pool: (summary: RhcPoolSummary) => UnifiedPool | null;
  openView: (summary: RhcPoolSummary) => RhcPoolView | null;
};
