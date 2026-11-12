"use client";

import type { ReactNode } from "react";
import { StocksOverview, type OverviewPosition } from "./stocks-overview";

/** Performance-tab all-stocks overview, including leftover rows for positions the overview does not cover. */
export function StocksSection({
  positions,
  selectedPositionKey,
  onSelectPosition,
  selectionDisabled,
  renderRemainingPositions,
}: {
  positions: OverviewPosition[];
  selectedPositionKey: string;
  onSelectPosition: (key: string) => void;
  selectionDisabled: boolean;
  renderRemainingPositions: (coveredKeys: ReadonlySet<string>) => ReactNode;
}) {
  return <StocksOverview embedded positions={positions} selectedPositionKey={selectedPositionKey}
    onSelectPosition={onSelectPosition} selectionDisabled={selectionDisabled}
    renderRemainingPositions={renderRemainingPositions} />;
}
