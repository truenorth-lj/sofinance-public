import { SUPPORTED, unsupported } from "@/lib/unified-positions/model";
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

/** Shown until the PR that ships each tool (PR6 add / withdraw / claim, PR7 compound / performance). */
const NOT_YET = "Not available for Meteora positions yet";

export const meteoraDlmmDescriptor: DexDescriptor = Object.freeze({
  id: "meteora-dlmm",
  chain: "solana",
  displayName: "Meteora",
  meta: Object.freeze({
    rangeUnit: "bin",
    /** One position account (8,120 bytes) holds at most 70 bins; wider ranges are refused, never split. */
    maxRangeUnitsPerPosition: 70,
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
  }),
  capabilities: Object.freeze({
    open: SUPPORTED,
    deposit: unsupported(NOT_YET),
    withdraw: Object.freeze({ supported: false, reason: NOT_YET }),
    claim: unsupported(NOT_YET),
    compound: unsupported(NOT_YET),
    performance: unsupported(NOT_YET),
    exitPreview: unsupported(NOT_YET),
    rangeDisplay: "price",
    manualAdd: false,
    signer: "solana-wallet",
  }),
} satisfies DexDescriptor);
