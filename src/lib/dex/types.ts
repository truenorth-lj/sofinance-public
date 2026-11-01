/**
 * Shared DEX contract, client-safe types and pure data only (design: meteora-positions/DESIGN.md §1).
 *
 * Every DEX (Raydium CLMM, Meteora DLMM, Uniswap v4 on Robinhood Chain, Orca Whirlpool, …) implements the same
 * `DexDescriptor` (what the UI may know) and `DexAdapter` (server-side reads and transaction preparation, see
 * `adapter.ts`). UI, API routes, cron and MCP reach a DEX only through the registry (`registry.ts`); protocol
 * differences are expressed as `meta` and `capabilities`, never as `protocol === "…"` branches.
 *
 * Nothing here imports a DEX SDK or a protocol module, so this file is safe in client bundles.
 */
import type { Capability, ChainId, SourceCapabilities, UnifiedPosition } from "@/lib/unified-positions/model";

/** The single canonical spelling of each DEX id (PM decision 8: "uniswap-v4-rhc", matching pool/feed/DB ids). */
export const DEX_IDS = ["raydium-clmm", "orca-whirlpool", "meteora-dlmm", "uniswap-v4-rhc"] as const;
export type DexId = (typeof DEX_IDS)[number];

/**
 * Legacy spellings accepted for one release, then removed. `"rhc-uniswap-v4"` is the unified-positions
 * `PositionSourceId` spelling (position keys in URLs/local storage may still carry it). Only `normalizeDexId` reads
 * this table (old URLs / localStorage); adapters and the contract suite use the canonical id
 * (`position.source === descriptor.id`).
 *
 * TODO(PR11): delete LEGACY_DEX_ID_ALIASES (and the "rhc-uniswap-v4" PositionSourceId) once Uniswap v4 on Robinhood
 * Chain is served through the registry and stored keys have been migrated.
 */
export const LEGACY_DEX_ID_ALIASES: Readonly<Record<string, DexId>> = Object.freeze({ "rhc-uniswap-v4": "uniswap-v4-rhc" });

export function isDexId(value: unknown): value is DexId {
  return typeof value === "string" && (DEX_IDS as readonly string[]).includes(value);
}

/** Canonical id for a current or legacy spelling; null for anything else. */
export function normalizeDexId(value: string | null | undefined): DexId | null {
  if (!value) return null;
  if (isDexId(value)) return value;
  return Object.hasOwn(LEGACY_DEX_ID_ALIASES, value) ? LEGACY_DEX_ID_ALIASES[value]! : null;
}

export type DexSigner = SourceCapabilities["signer"];
export type DexOp = "quoteOpen" | "open" | "add" | "withdraw" | "claim" | "compound";

/**
 * Platform-fee rule per operation. Declared as data so the policy is reviewable and contract-tested; the collecting
 * mechanism (Jupiter platformFee, a harvest transfer, a Uniswap UR takePortion) stays inside each adapter, behind the
 * shared fee-wallet guards. Rates are basis points.
 */
export type FeeRule =
  | { kind: "none" }
  /** Charged on the swapped input of a deposit leg (unswapped amounts are free). */
  | { kind: "swap-input-bps"; bps: number }
  /** Charged on a swap's output (e.g. withdraw to USDC). */
  | { kind: "swap-output-bps"; bps: number }
  /** Charged on harvested yield being compounded. */
  | { kind: "harvest-bps"; bps: number };
export type FeeOp = "open" | "add" | "compound" | "claim" | "withdrawPoolTokens" | "withdrawUsdc";
export type FeePolicy = Readonly<Record<FeeOp, FeeRule>>;

export const NO_FEE: FeeRule = Object.freeze({ kind: "none" });

/** Basis points a rule charges (0 for "none"). */
export function feeRuleBps(rule: FeeRule): number {
  return rule.kind === "none" ? 0 : rule.bps;
}

/** Solana rent the user sets aside; null on chains without rent (EVM). */
export type DexRentModel = {
  /** Whether a position's rent comes back on full withdraw. Amounts come from `OpenQuote.rent` (live rent rate). */
  refundableOnClose: boolean;
  /** Plain-English line shown before signing, e.g. "about 0.042 SOL, refunded when you fully withdraw". */
  disclosure: string;
};

/** Protocol facts the UI may need, as data, so no layer above the registry branches on a protocol id. */
export type DexMeta = {
  /** What a range is counted in: CLMM / Uniswap v4 / Whirlpool ticks, or DLMM bins. */
  rangeUnit: "tick" | "bin";
  /** Most ticks/bins one position may span in one open; null = no protocol cap. */
  maxRangeUnitsPerPosition: number | null;
  /** How many signed steps an open takes (Raydium 1; Meteora setup + deposit; Uniswap v4 approve/permit/execute). */
  openSteps: { min: number; max: number };
  rent: DexRentModel | null;
  /** EVM token approval model; Solana DEXes use "none". */
  approvals: "none" | "erc20-permit2";
  /** Who must co-sign a new position besides the wallet (Raydium NFT mint, Meteora position keypair). */
  positionCosigner: "none" | "ephemeral-keypair" | "nft-mint";
  /** Address comparison rule for this chain's token ids. */
  addressCase: "exact" | "lowercase";
  feePolicy: FeePolicy;
};

/** Unified-positions capabilities plus the two this contract adds. */
export type DexCapabilities = SourceCapabilities & {
  /** Opening a new position from the pools list / cards. */
  open: Capability;
  /** Claiming accrued fees without changing liquidity. */
  claim: Capability;
};

/** UI-safe description of one DEX: the registry element the UI reads (extends the unified-positions source). */
export type DexDescriptor<N = unknown> = {
  id: DexId;
  chain: ChainId;
  displayName: string;
  meta: DexMeta;
  capabilities: DexCapabilities;
  /** Per-position overrides, merged over `capabilities` by `capabilitiesFor` (same rule as unified positions). */
  positionCapabilities?(position: UnifiedPosition<N>): Partial<DexCapabilities>;
};
