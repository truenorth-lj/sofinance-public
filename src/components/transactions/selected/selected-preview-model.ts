import type { SelectedQuote } from "@/lib/selected-quote";
import type { PositionSelection, SelectedPositionState } from "@sofinance/engine/selected-state";

/**
 * Client deadline for a preview/prepare. Each server round keeps its own 8 s
 * deadline; the browser-fetched Jupiter rounds in between are paced to the
 * keyless per-IP quota, so the whole exchange gets more room.
 */
export const RELAY_DEADLINE_MS = 20_000;

export type Preflight = { quote: SelectedQuote; simulated: boolean; sizeBytes?: number; unitsConsumed?: number;
  feeLamports?: number; startingLiquidity?: string; simulatedEndingLiquidity?: string;
  simulatedAt?: number; expiresAt?: number; startingBalances?: SelectedPositionState["balances"];
  simulatedInputSpent?: string | null; simulatedSolDebitLamports?: string;
  simulatedDustA?: string; simulatedDustB?: string; blockhash?: string;
  lastValidBlockHeight?: number };
export type Preview = { kind: "idle" } | { kind: "quoted"; result: Preflight };

export function selectionKey(selection: PositionSelection | null) {
  return selection ? `${selection.positionMint}:${selection.inputKind}:${selection.inputMint}` : "";
}

