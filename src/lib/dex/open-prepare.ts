/** Compatibility contracts for native open transports, separate from generic StepResult rollout. */
import type { VersionedTransaction } from "@solana/web3.js";
import type { OpenRangeInput } from "@sofinance/engine/open-range-input";
import type { OpenPositionQuote, OpenPositionSummary } from "@sofinance/engine/open-types";
export const APP_OPEN_PREPARE = "app-open";
export const MCP_OPEN_PREPARE = "mcp-open";
export const APP_OPEN_QUOTE = "app-open-quote";
export const MCP_OPEN_QUOTE = "mcp-open-quote";
export type OpenPrepareProfile = typeof APP_OPEN_PREPARE | typeof MCP_OPEN_PREPARE;
export type OpenQuoteProfile = typeof APP_OPEN_QUOTE | typeof MCP_OPEN_QUOTE;
export type OpenQuoteCommand = {
  wallet: string;
  selection: { poolId: string; inputMint: string; inputKind: "native" | "token" };
  amount: string;
  range: OpenRangeInput;
  floorBps: number;
  toleranceBps?: number;
};
export type OpenPrepareCommand = OpenQuoteCommand & {
  nftMint: string;
  /** Legacy step-2 resume input; ignored and never waives the fee. */
  solSwapSignature?: string;
};
export type BuildOpen = (command: OpenPrepareCommand, options?: { enforceResaleFloor: false }) => Promise<{
  summary: OpenPositionSummary; transaction: VersionedTransaction;
}>;
export type QuoteOpen = (command: OpenQuoteCommand, profile: OpenQuoteProfile) => Promise<OpenPositionQuote>;
export const SINGLE_TX_SOL_OPEN_MESSAGE = "SOL deposits open in two steps (1/2 swap SOL to a pool token, 2/2 open). Swap SOL to a pool token first, then open with that token.";
