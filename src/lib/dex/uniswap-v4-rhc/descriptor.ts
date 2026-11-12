import { OPEN_FEE_BPS } from "@sofinance/engine/protocols/uniswap-v4/open-constants";
import { NOT_AVAILABLE_MESSAGE, unsupported } from "@/lib/unified-positions/model";
import { NO_FEE } from "../types";
import type { DexDescriptor, FeePolicy } from "../types";

/**
 * Uniswap v4 on Robinhood Chain, client-safe (E2-register). Pure data: no SDK, no engine I/O, no server code.
 * `feePolicy.open.bps` is derived from the engine `OPEN_FEE_BPS` constant (same module is data-only; the
 * architecture-dex client.ts walk allows this because it never reaches server-only, a DEX SDK, or `*.server.ts`).
 *
 * The live open/close money path stays on `/api/rhc-univ4-open` and `/api/rhc-univ4-exit` plus the
 * `rhc-dialog` shell. This descriptor records the already-shipped fee policy and UI flags; it does not
 * invent a rate. Generic `/api/dex/uniswap-v4-rhc/*` is disabled (`module.enabled` is always false).
 *
 * `openUi` stays `rhc-dialog`, `useDescriptorPlanTerms` stays false, `listPositions` is false (listing
 * moves in E2-alias). The generic StepResult open/withdraw/claim/compound/plan capabilities are
 * unsupported so registry tools and a Plan button do not appear. The pools Open button still uses
 * `openUi`, not these caps.
 */
const NOT_YET = NOT_AVAILABLE_MESSAGE;

/** Existing open fee: OPEN_FEE_BPS on swap output only. Every other op is none (no add/claim/compound; no fee on exit). */
export const UNISWAP_V4_RHC_FEE_POLICY: FeePolicy = Object.freeze({
  open: Object.freeze({ kind: "swap-output-bps", bps: Number(OPEN_FEE_BPS) }),
  add: NO_FEE,
  compound: NO_FEE,
  claim: NO_FEE,
  withdrawPoolTokens: NO_FEE,
  withdrawUsdc: NO_FEE,
});

export const uniswapV4RhcDescriptor: DexDescriptor = Object.freeze({
  id: "uniswap-v4-rhc",
  chain: "robinhood-chain",
  displayName: "Uniswap v4",
  meta: Object.freeze({
    rangeUnit: "tick" as const,
    maxRangeUnitsPerPosition: null,
    /** Uniswap v4 tick bounds (`MIN_TICK` / `MAX_TICK` in packages/engine). Copied as data so this file stays client-safe. */
    rangeUnitBounds: Object.freeze({ min: -887_272, max: 887_272 }),
    /** Wallet steps: Permit2 sign + execute, or approve + sign + execute. The generic step pipeline is not used. */
    openSteps: Object.freeze({ min: 2, max: 3 }),
    rent: null,
    approvals: "erc20-permit2" as const,
    positionCosigner: "none" as const,
    addressCase: "lowercase" as const,
    feePolicy: UNISWAP_V4_RHC_FEE_POLICY,
    depositInputs: Object.freeze({ poolTokens: true, extra: Object.freeze([]) }),
  }),
  capabilities: Object.freeze({
    open: unsupported(NOT_YET),
    deposit: unsupported(NOT_YET),
    withdraw: Object.freeze({ supported: false, reason: NOT_YET }),
    withdrawOutputs: Object.freeze([] as const),
    claim: unsupported(NOT_YET),
    compound: unsupported(NOT_YET),
    plan: unsupported(NOT_YET),
    performance: unsupported(NOT_YET),
    exitPreview: unsupported(NOT_YET),
    rangeDisplay: "tick" as const,
    manualAdd: false,
    signer: "evm-wallet" as const,
  }),
  ui: Object.freeze({
    openUi: "rhc-dialog" as const,
    useDescriptorPlanTerms: false,
    listPositions: false,
  }),
} satisfies DexDescriptor);
