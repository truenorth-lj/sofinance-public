import { useState } from "react";
import { RaydiumRowCompound } from "../compound-panel";
import type { CompoundController } from "../use-compound-controller";

/**
 * Tests only: what /app renders for a Raydium position's compound (LJ 11/14): the row's Compound button, which opens the
 * row's Compound popup (static confirm → the existing flow → its status and result in the same popup).
 */
export function RowCompoundHarness({ controller, unclaimedUsd = 1.23 }: { controller: CompoundController; unclaimedUsd?: number | null }) {
  const [open, setOpen] = useState(false);
  const mint = controller.positionMint ?? "";
  return <div>
    <ul><li data-testid="position-row">
      <RaydiumRowCompound controller={controller} positionMint={mint} positionKey={`raydium-clmm:${mint}`}
        slot={{ disabled: controller.busy, otherActions: null, open, onOpen: () => setOpen(true), onClose: () => setOpen(false), unclaimedUsd }} />
    </li></ul>
  </div>;
}
