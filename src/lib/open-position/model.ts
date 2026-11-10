/**
 * Shared open-position venue contract. The shell reads this view-model; it never branches on a
 * protocol id. Each venue adapter (Raydium controller, registry dexTxAdapter, RHC open panel)
 * fills it in without changing how transactions are built. See /workspace/unified-open-position/DESIGN.md.
 */
export type OpenVenueId = "raydium-clmm" | "orca-whirlpool" | "meteora-dlmm" | "rhc-uniswap-v4";
export type RangeUnit = "tick" | "bin" | "rhc-tick";
export type SignerKind = "solana-wallet" | "evm-wallet";

export type OpenCapabilities = {
  customRange: boolean;
  maxRangeUnits: number | null;
  rangeUnit: RangeUnit;
  rentNote: boolean;
  twoStepSolSwap: boolean;
  nativeSolInput: boolean;
  evmNetworkPrompt: boolean;
  approvalSteps: boolean;
  openStepsMax: number;
  signer: SignerKind;
};

export const RAYDIUM_OPEN_CAPABILITIES: OpenCapabilities = {
  customRange: true, maxRangeUnits: null, rangeUnit: "tick",
  rentNote: true, twoStepSolSwap: true, nativeSolInput: true,
  evmNetworkPrompt: false, approvalSteps: false, openStepsMax: 2, signer: "solana-wallet",
};

export const REGISTRY_DLMM_OPEN_CAPABILITIES: OpenCapabilities = {
  customRange: false, maxRangeUnits: 70, rangeUnit: "bin",
  rentNote: true, twoStepSolSwap: false, nativeSolInput: false,
  evmNetworkPrompt: false, approvalSteps: false, openStepsMax: 2, signer: "solana-wallet",
};

export const RHC_OPEN_CAPABILITIES: OpenCapabilities = {
  customRange: true, maxRangeUnits: null, rangeUnit: "rhc-tick",
  rentNote: false, twoStepSolSwap: false, nativeSolInput: false,
  evmNetworkPrompt: true, approvalSteps: true, openStepsMax: 1, signer: "evm-wallet",
};
