import "@/lib/engine-host";

import { JUPITER_NO_ROUTE_CODE } from "@sofinance/engine/jupiter/errors";
import { tokenSymbol } from "./position-label";

export { JUPITER_NO_ROUTE_CODE };

export function formatSelectedNoRouteMessage(inputLabel: string, outputLabel: string) {
  return `No route from ${inputLabel} to ${outputLabel} within the transaction size limit. Try USDC, SOL, or one of the pool's tokens.`;
}

export class SelectedNoRouteError extends Error {
  readonly code = JUPITER_NO_ROUTE_CODE;
  readonly inputMint: string;
  readonly outputMint: string;
  constructor(inputLabel: string, outputLabel: string, inputMint: string, outputMint: string) {
    super(formatSelectedNoRouteMessage(inputLabel, outputLabel));
    this.name = "SelectedNoRouteError";
    this.inputMint = inputMint;
    this.outputMint = outputMint;
  }
}

export type SelectedNoRouteState = {
  inputMint: string;
  inputKind: "native" | "token";
  mintA: string;
  mintB: string;
  rangeSide: string;
};

export function selectedNoRouteOutputMint(state: SelectedNoRouteState) {
  return state.rangeSide === "above" ? state.mintB : state.mintA;
}

export function selectedNoRouteError(state: SelectedNoRouteState) {
  const outputMint = selectedNoRouteOutputMint(state);
  const inputLabel = state.inputKind === "native" ? "SOL" : tokenSymbol(state.inputMint);
  return new SelectedNoRouteError(inputLabel, tokenSymbol(outputMint), state.inputMint, outputMint);
}
