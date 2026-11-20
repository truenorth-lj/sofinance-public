import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { NOT_AVAILABLE_MESSAGE, SUPPORTED, unsupported } from "@/lib/unified-positions/model";
import { ADD_VALUE_FLOOR_BPS } from "../add-value-guard";
import { NO_FEE_POLICY } from "../fees";
import type { DexDescriptor, FeePolicy } from "../types";

/**
 * Raydium CLMM, client-safe (E3). Pure data: no SDK, no engine I/O, no server builders.
 *
 * The live write path stays the dedicated open/withdraw/compound/selected/sol-swap prepare
 * routes and the native modal. Generic `/api/dex/raydium-clmm/*` stays 404 (`module.enabled`
 * is always false). `/app` listing stays the inline wallet scan (`listPositions: false`).
 * Plan / share-calc stay on `LEGACY_*` (`useDescriptorPlanTerms: false`); the pools-page Plan
 * link keeps `planFallback` because `openUi` is `native-modal`.
 *
 * `feePolicy` declares the existing default 10 bps swap-input rule already implemented in
 * `packages/engine/src/swap/fee.ts`. It is not a second collector and does not invent a rate.
 */
const RAYDIUM_CLMM_FEE_POLICY: FeePolicy = Object.freeze({
  ...NO_FEE_POLICY,
  open: Object.freeze({ kind: "swap-input-bps", bps: 10 }),
  add: Object.freeze({ kind: "swap-input-bps", bps: 10 }),
  compound: Object.freeze({ kind: "swap-input-bps", bps: 10 }),
  withdrawUsdc: Object.freeze({ kind: "swap-input-bps", bps: 10 }),
});

/** Single declaration of the tools already shipped in the native App and compatibility transports. */
const NATIVE_POSITION_CAPABILITIES = Object.freeze({
  compound: SUPPORTED,
  performance: SUPPORTED,
  deposit: SUPPORTED,
  withdraw: Object.freeze({ supported: true as const, partial: true }),
  withdrawOutputs: Object.freeze(["pool-tokens", "usdc", "sol"] as const),
  exitPreview: Object.freeze({ supported: true as const, output: "usdc+sol" as const }),
  rangeDisplay: "price" as const,
  manualAdd: false,
  signer: "solana-wallet" as const,
});

const NOT_YET = NOT_AVAILABLE_MESSAGE;

export const raydiumClmmDescriptor: DexDescriptor = Object.freeze({
  id: "raydium-clmm",
  chain: "solana",
  displayName: "Raydium CLMM",
  meta: Object.freeze({
    rangeUnit: "tick" as const,
    maxRangeUnitsPerPosition: null,
    /** In-repo CLMM tick bounds (`MIN_TICK` / `MAX_TICK` in packages/engine). Copied as data so this file stays client-safe of builders. */
    rangeUnitBounds: Object.freeze({ min: -443_636, max: 443_636 }),
    /** Token-input open is one transaction (wallet + NFT mint signatures). SOL deposits are two transactions. */
    openSteps: Object.freeze({ min: 1, max: 2 }),
    rent: null,
    approvals: "none" as const,
    positionCosigner: "nft-mint" as const,
    addressCase: "exact" as const,
    feePolicy: RAYDIUM_CLMM_FEE_POLICY,
    /** Selected-position Add (USDC / SOL / pool token in) is valued at independent prices before signing. */
    addValueFloorBps: ADD_VALUE_FLOOR_BPS,
    depositInputs: Object.freeze({
      poolTokens: true,
      extra: Object.freeze([
        { id: USDC_MINT, symbol: "USDC", decimals: 6 },
        { id: NATIVE_SOL_MINT, symbol: "SOL", decimals: 9 },
      ]),
    }),
  }),
  nativeCapabilities: Object.freeze({ open: SUPPORTED, positions: NATIVE_POSITION_CAPABILITIES }),
  capabilities: Object.freeze({
    ...NATIVE_POSITION_CAPABILITIES,
    /** Add is implemented and contract-tested; module.enabled still keeps every generic route closed. */
    open: unsupported(NOT_YET),
    withdraw: Object.freeze({ supported: false, reason: NOT_YET }),
    withdrawOutputs: Object.freeze([] as const),
    claim: unsupported(NOT_YET),
    compound: unsupported(NOT_YET),
    plan: unsupported(NOT_YET),
    performance: unsupported(NOT_YET),
    exitPreview: unsupported(NOT_YET),
  }),
  ui: Object.freeze({
    rangeApr: Object.freeze({ route: "pool" as const, cacheScope: "pool" as const }),
    openUi: "native-modal" as const,
    planFallback: SUPPORTED,
    externalPoolUrl: (poolId: string) => `https://raydium.io/clmm/create-position/?pool_id=${poolId}`,
    useDescriptorPlanTerms: false,
    listPositions: false,
  }),
} satisfies DexDescriptor);
