import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { buildAndSimulateCompound, compileCompoundTransaction } from "../compound-atomic";
import { buildPositionExitInstructions } from "../lp-exit-instructions";
import { buildAndSimulateOpenPosition } from "../open-atomic";
import { getOpenPositionQuoteBundle } from "../open-quote";
import { estimateOpenPositionRent } from "../open-rent";
import { readOpenPoolState } from "../open-state";
import { readSelectedPositionState } from "../selected-state";
import { compoundProtocolInstructions } from "../swap/receipt";
import { discoverWallet } from "../wallet-discovery";
import type { ClmmProtocolAdapter } from "./types";

/**
 * Raydium CLMM behind the protocol-adapter contract. Every member resolves to
 * the existing builder itself (not a wrapper), so routing through the adapter
 * is byte-for-byte identical to calling the builders directly. Members are
 * read lazily through getters so that importing the registry never touches a
 * builder a caller does not use (keeps partial module mocks in tests valid).
 */
export const raydiumClmmAdapter: ClmmProtocolAdapter = Object.freeze({
  id: "raydium-clmm",
  label: "Raydium CLMM",
  get programId() { return CLMM_PROGRAM_ID; },
  get readOpenPoolState() { return readOpenPoolState; },
  get estimateOpenPositionRent() { return estimateOpenPositionRent; },
  get getOpenPositionQuoteBundle() { return getOpenPositionQuoteBundle; },
  get buildAndSimulateOpenPosition() { return buildAndSimulateOpenPosition; },
  get readPositionState() { return readSelectedPositionState; },
  get buildAndSimulateCompound() { return buildAndSimulateCompound; },
  get compileCompoundTransaction() { return compileCompoundTransaction; },
  get buildPositionExitInstructions() { return buildPositionExitInstructions; },
  get discoverWallet() { return discoverWallet; },
  get protocolInstructions() { return compoundProtocolInstructions; },
} satisfies ClmmProtocolAdapter);
