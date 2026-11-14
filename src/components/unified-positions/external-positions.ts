import type { ReactNode } from "react";
import type { ChainId, PositionSource, PositionSourceId, ToolId, UnifiedPosition } from "@/lib/unified-positions/model";

/**
 * Another chain's positions inside `/app` My positions (today: Robinhood Chain). The shared panel renders the group, header,
 * details and tools only through this binding and the source's capabilities, never by checking the chain.
 */
export type ExternalPositions = {
  chain: ChainId;
  /** Enabled sources on this chain (source names show in labels only with 2+). */
  sourceIds: readonly PositionSourceId[];
  source: PositionSource<never>;
  positions: UnifiedPosition[];
  /** Under the dropdown: wallet, manual "Position NFT #", scan status, wrong-network prompt, last close status. */
  status: ReactNode;
  busy: boolean;
  header(position: UnifiedPosition): ReactNode;
  details(position: UnifiedPosition): ReactNode;
  tool(position: UnifiedPosition, tool: ToolId): ReactNode;
};
