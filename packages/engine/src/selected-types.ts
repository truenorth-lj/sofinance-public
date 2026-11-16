/** Public selected-position DTOs. Type-only dependency; no SDK or RPC code executes here. */
import type { readSelectedPositionState } from "./selected-state";
export type PositionSelection = { positionMint: string; inputMint: string; inputKind: "native" | "token" };
export type SelectedPositionState = Awaited<ReturnType<typeof readSelectedPositionState>>;
