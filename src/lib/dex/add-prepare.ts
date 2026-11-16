/** Server-side compatibility contract for the existing app / MCP add transports. */
import type { PositionSelection } from "@sofinance/engine/selected-types";
import type { JupiterRetryBudget } from "@sofinance/engine/jupiter/client";
import type { SelectedPermitInput } from "@/lib/selected-permit";
import type { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";

// Trusted entrypoints select these profiles; they are never read from request bodies.
export const APP_ADD_PREPARE = "app-selected";
export const MCP_ADD_PREPARE = "mcp-selected";
export type AddPrepareCommand = {
  wallet: string;
  selection: PositionSelection;
  amount: string;
  floorBps: number;
  toleranceBps?: number;
};
export type AddPrepareContext = { signal: AbortSignal; budget: JupiterRetryBudget };
export type AddPrepareSurface = [profile: typeof APP_ADD_PREPARE, context: AddPrepareContext]
  | [profile: typeof MCP_ADD_PREPARE];
export type AddSubmitArgs = Omit<SelectedPermitInput, "message"> & { permit: string };
export type AddPreparation = {
  summary: Awaited<ReturnType<typeof buildAndSimulateSelectedZap>>["summary"];
  permit: string;
  unsignedTransaction: string;
  submitArgs: AddSubmitArgs;
  sendPermit?: string;
  landedPermit?: string;
};
/** Shared full-simulation binding; raw-unit adapters normalize their input before calling it. */
export type BuildAdd = (command: AddPrepareCommand, options?: Parameters<typeof buildAndSimulateSelectedZap>[5]) => ReturnType<typeof buildAndSimulateSelectedZap>;
