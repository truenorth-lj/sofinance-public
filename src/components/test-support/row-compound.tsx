import { RaydiumCompoundFeedback, RaydiumRowCompound } from "../compound-panel";
import type { CompoundController } from "../use-compound-controller";

/**
 * Tests only: what /app renders for a selected Raydium position's compound (LJ 11/14, no Compound fees panel): the row's
 * Compound button with its status, and the page-level submit dialog.
 */
export function RowCompoundHarness({ controller }: { controller: CompoundController }) {
  return <div>
    <ul><li data-testid="position-row">
      <RaydiumRowCompound controller={controller} positionMint={controller.positionMint ?? ""} pending={false}
        onCompound={controller.compound} slot={{ disabled: controller.busy, otherActions: null }} />
    </li></ul>
    <RaydiumCompoundFeedback controller={controller} />
  </div>;
}
