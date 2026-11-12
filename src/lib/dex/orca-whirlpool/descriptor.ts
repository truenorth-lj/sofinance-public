import { NOT_AVAILABLE_MESSAGE, unsupported } from "@/lib/unified-positions/model";
import { NO_FEE_POLICY } from "../fees";
import type { DexDescriptor } from "../types";

/**
 * Orca Whirlpool, client-safe (E1). Pure data: no SDK, no engine I/O, no server code.
 *
 * Read-only and hidden in this series: `openUi` is "none", plan terms stay on `LEGACY_*`, and
 * `listPositions` is false so the unified positions UI does not fetch Orca (preview included).
 * SoFinance collects no platform fee (LJ has not approved Orca fee rules), so `feePolicy` is the
 * shared `NO_FEE_POLICY` — every op is `{ kind: "none" }`, not an invented rate.
 */
const NOT_YET = NOT_AVAILABLE_MESSAGE;

export const orcaWhirlpoolDescriptor: DexDescriptor = Object.freeze({
  id: "orca-whirlpool",
  chain: "solana",
  displayName: "Orca",
  meta: Object.freeze({
    rangeUnit: "tick" as const,
    /** No protocol cap analogous to DLMM's 70-bin account; the legal tick range is the bound. */
    maxRangeUnitsPerPosition: null,
    /** In-repo Whirlpool tick bounds (`ORCA_MIN_TICK` / `ORCA_MAX_TICK` in packages/engine). Copied as data so this file stays client-safe. */
    rangeUnitBounds: Object.freeze({ min: -443_636, max: 443_636 }),
    /** A Whirlpool open is a single transaction when we ship one; E1 does not open. */
    openSteps: Object.freeze({ min: 1, max: 1 }),
    /** No plan/open copy in this series (`useDescriptorPlanTerms` is false). */
    rent: null,
    approvals: "none" as const,
    positionCosigner: "none" as const,
    addressCase: "exact" as const,
    feePolicy: NO_FEE_POLICY,
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
    rangeDisplay: "price" as const,
    manualAdd: false,
    signer: "solana-wallet" as const,
  }),
  ui: Object.freeze({
    openUi: "none" as const,
    useDescriptorPlanTerms: false,
    /** E1 must not list Orca in the unified positions UI, including preview. */
    listPositions: false,
  }),
} satisfies DexDescriptor);
