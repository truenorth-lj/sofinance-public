import { USDC_MINT } from "@sofinance/engine/ids";
import { NOT_AVAILABLE_MESSAGE, SUPPORTED, unsupported } from "@/lib/unified-positions/model";
import { NO_FEE_POLICY } from "../fees";
import type { DexDescriptor, FeePolicy } from "../types";

/**
 * Meteora DLMM, client-safe (DESIGN.md §1.3, §7). Pure data: no SDK, no engine, no server code.
 *
 * Fee rates live only here (`meta.feePolicy`); the adapter reads them through `bpsFeeStrategy`. Deposits pay the
 * rate on the swapped part of the input only (inside the Jupiter swap, into the fee wallet's pre-existing ATA for the
 * input mint); the part already in a pool token is free. Compound charges nothing (PM decision 11/1).
 */
export const METEORA_DLMM_FEE_POLICY: FeePolicy = Object.freeze({
  ...NO_FEE_POLICY,
  open: Object.freeze({ kind: "swap-input-bps", bps: 10 }),
  add: Object.freeze({ kind: "swap-input-bps", bps: 10 }),
  withdrawUsdc: Object.freeze({ kind: "swap-output-bps", bps: 10 }),
});

/**
 * Shown until the PR that ships each tool (PR7 compound / performance / exit preview). The shared generic
 * text, never a DEX name: the UI only renders the capability's reason (PM 11/1).
 */
const NOT_YET = NOT_AVAILABLE_MESSAGE;

export const meteoraDlmmDescriptor: DexDescriptor = Object.freeze({
  id: "meteora-dlmm",
  chain: "solana",
  displayName: "Meteora",
  meta: Object.freeze({
    rangeUnit: "bin",
    /** One position account (8,120 bytes) holds at most 70 bins; wider ranges are refused, never split. */
    maxRangeUnitsPerPosition: 70,
    /** lb_clmm `MIN_BIN_ID` / `MAX_BIN_ID` (±443,636). A pool's bin step can narrow this further; the adapter checks that on chain. */
    rangeUnitBounds: Object.freeze({ min: -443_636, max: 443_636 }),
    /** 1/2 setup (create the position account), 2/2 deposit (swap legs + add liquidity). */
    openSteps: Object.freeze({ min: 2, max: 2 }),
    rent: Object.freeze({
      refundableOnClose: true,
      disclosure: "Opening sets aside about 0.042 SOL as position rent. You get it back when you fully withdraw.",
    }),
    approvals: "none",
    /** The new position account is a fresh keypair the browser creates and signs with (never sent to the server). */
    positionCosigner: "ephemeral-keypair",
    addressCase: "exact",
    feePolicy: METEORA_DLMM_FEE_POLICY,
    /** Same inputs as opening (SOL is refused). */
    depositInputs: Object.freeze({ poolTokens: true, extra: Object.freeze([{ id: USDC_MINT, symbol: "USDC", decimals: 6 }]) }),
  }),
  capabilities: Object.freeze({
    open: SUPPORTED,
    /** PR6: add to an existing position (same input tokens and fee rule as opening). */
    deposit: SUPPORTED,
    /**
     * PR6: partial (remove a share; the unclaimed fees stay in the position) and full (remove all, claim, close, rent
     * back), to the pool's two tokens.
     */
    withdraw: Object.freeze({ supported: true, partial: true, partialLeavesFees: true }),
    /** v1 pays out the pool's two tokens only (no "withdraw to USDC"; PM 11/1). */
    withdrawOutputs: Object.freeze(["pool-tokens"] as const),
    /** PR6: claim accrued swap fees without changing liquidity (no fee). */
    claim: SUPPORTED,
    compound: unsupported(NOT_YET),
    performance: unsupported(NOT_YET),
    exitPreview: unsupported(NOT_YET),
    rangeDisplay: "price",
    manualAdd: false,
    signer: "solana-wallet",
  }),
} satisfies DexDescriptor);
