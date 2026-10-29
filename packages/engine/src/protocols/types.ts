import type { PublicKey } from "@solana/web3.js";
import type { buildAndSimulateCompound, compileCompoundTransaction } from "../compound-atomic";
import type { buildPositionExitInstructions } from "../lp-exit-instructions";
import type { buildAndSimulateOpenPosition } from "../open-atomic";
import type { getOpenPositionQuoteBundle } from "../open-quote";
import type { estimateOpenPositionRent } from "../open-rent";
import type { readOpenPoolState } from "../open-state";
import type { readSelectedPositionState } from "../selected-state";
import type { compoundProtocolInstructions } from "../swap/receipt";
import type { discoverWallet } from "../wallet-discovery";

/**
 * Concentrated-liquidity protocols the engine can build for. Only Raydium CLMM
 * is implemented today; Orca Whirlpools and Meteora DLMM land in later PRs.
 */
export const PROTOCOL_IDS = ["raydium-clmm"] as const;
export type ProtocolId = (typeof PROTOCOL_IDS)[number];
export const DEFAULT_PROTOCOL: ProtocolId = "raydium-clmm";

/**
 * Protocols whose pools can be listed (read-only discovery). A superset of
 * PROTOCOL_IDS: Orca pools are discoverable before Orca can build
 * transactions, and `getProtocolAdapter` only accepts a `ProtocolId`.
 */
export const POOL_PROTOCOL_IDS = ["raydium-clmm", "orca-whirlpool"] as const;
export type PoolProtocolId = (typeof POOL_PROTOCOL_IDS)[number];

/**
 * One protocol's open / add / compound / exit / read surface.
 *
 * The SoFinance swap fee is deliberately NOT part of this contract: fees are
 * collected by the shared swap legs (`swap/fee.ts`, `swap/collection.ts`), so an
 * adapter only ever contributes protocol instructions and never sees the fee
 * wallet. Signatures currently mirror the Raydium builders one-for-one; they are
 * generalized when a second protocol is added.
 */
export type ClmmProtocolAdapter = {
  readonly id: ProtocolId;
  readonly label: string;
  readonly programId: PublicKey;
  /** Pool + wallet state for a new position. */
  readOpenPoolState: typeof readOpenPoolState;
  estimateOpenPositionRent: typeof estimateOpenPositionRent;
  getOpenPositionQuoteBundle: typeof getOpenPositionQuoteBundle;
  /** Swap legs + open position in one packet. */
  buildAndSimulateOpenPosition: typeof buildAndSimulateOpenPosition;
  /** Existing position state, shared by add, compound and exit. */
  readPositionState: typeof readSelectedPositionState;
  buildAndSimulateCompound: typeof buildAndSimulateCompound;
  compileCompoundTransaction: typeof compileCompoundTransaction;
  /** Decrease (with fee/reward harvest) and optional close. */
  buildPositionExitInstructions: typeof buildPositionExitInstructions;
  /** Wallet assets and this protocol's positions. */
  discoverWallet: typeof discoverWallet;
  /** Protocol instructions inside a parsed transaction (receipts / recovery). */
  protocolInstructions: typeof compoundProtocolInstructions;
};
