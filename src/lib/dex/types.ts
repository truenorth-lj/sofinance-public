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
import type { Capability, ChainId, SourceCapabilities, TokenRef, UnifiedPosition } from "@/lib/unified-positions/model";

/** The single canonical spelling of each DEX id (PM decision 8: "uniswap-v4-rhc", matching pool/feed/DB ids). */
export const DEX_IDS = ["raydium-clmm", "orca-whirlpool", "meteora-dlmm", "uniswap-v4-rhc"] as const;
export type DexId = (typeof DEX_IDS)[number];

/**
 * Legacy spellings accepted for one release, then removed. `"rhc-uniswap-v4"` is still readable on
 * stored position keys and leftover protocol spellings (`normalizeDexId`, `parsePositionKey`).
 * Adapters and the contract suite emit the canonical id (`position.source === descriptor.id`).
 * `uiFor` inherits the canonical descriptor's UI. Do not delete this table in this PR; a later
 * cleanup may drop it (and the alias `PositionSourceId`) once stored keys have been migrated.
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
  /**
   * Typical rent of one new position in SOL, for planning copy only (the Plan page's opening-cost note); real opens use
   * `OpenQuote.rent`. Omitted when there is no fixed typical figure.
   */
  planEstimateSol?: string;
};

/** Protocol facts the UI may need, as data, so no layer above the registry branches on a protocol id. */
export type DexMeta = {
  /** What a range is counted in: CLMM / Uniswap v4 / Whirlpool ticks, or DLMM bins. */
  rangeUnit: "tick" | "bin";
  /** Most ticks/bins one position may span in one open; null = no protocol cap. */
  maxRangeUnitsPerPosition: number | null;
  /**
   * The protocol's legal tick / bin id range (inclusive). The generic route refuses a `units` range outside it with 400
   * before any adapter work, so no route code needs to know which DEX counts in ticks or bins.
   */
  rangeUnitBounds: { min: number; max: number };
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
  /**
   * Share of a swap's gross fee the pool pays its LPs after the protocol's own cut (0–1), for planning only: the Plan
   * page scales the pool fee APR by it. Omitted = the pool fee APR is already what LPs keep.
   */
  planLpFeeShare?: number;
  /**
   * Tokens an Add (deposit into an existing position) accepts: the pool's own two (`poolTokens`) plus any other token
   * the adapter swaps in (`extra`, e.g. USDC on Solana). The Add panel offers exactly these.
   */
  depositInputs: { poolTokens: boolean; extra: readonly TokenRef[] };
  /**
   * A fee the pool itself may take when tokens are added while the price is inside the range (not ours), as the plain
   * line the Compound panel shows before signing; omitted when the protocol has none.
   */
  inRangeDepositPoolFee?: string;
};

/** Unified-positions capabilities plus the two this contract adds. */
export type DexCapabilities = SourceCapabilities & {
  /** Opening a new position from the pools list / cards. */
  open: Capability;
  /** Claiming accrued fees without changing liquidity. */
  claim: Capability;
  /**
   * "Plan this pool" on the pools list: /app/plan for this DEX's pools (the daily fee APR series of
   * /api/pool-daily-apr, served through `DexModule.poolDailyApr`). Unsupported = the link is greyed with the reason.
   */
  plan: Capability;
};

/**
 * Which open shell the pools page / deep link uses. Data on `DexUi`, never a `protocol === "…"` at the call site.
 */
export type DexOpenUi = "registry" | "native-modal" | "rhc-dialog" | "none";

/**
 * Client-safe UI record (Phase E, docs/refactor/phase-e-dex-registry.md §2.2).
 * Does not include `showHighestRange` or `nullFeeLabel` (those stay on `CHAIN_META`).
 * No invented `feePolicy`.
 */
export type DexUi = {
  /** Which open shell the pools page / deep link uses. */
  openUi: DexOpenUi;
  /** Off-site venue URL, if any. */
  externalPoolUrl?: (poolAddress: string) => string;
  /**
   * When true, `/app/plan` and the share calculator use descriptor fee/rent terms.
   * When false, they keep `LEGACY_*` in `lp-plan-pool-terms.ts`.
   * Explicit data: true only on Meteora's `descriptor.ui`; unregistered venues are false.
   */
  useDescriptorPlanTerms: boolean;
  /** Plan link when this venue has no descriptor yet (Raydium). Ignored when `capabilities.plan` exists. */
  planFallback?: Capability;
  /**
   * When false, the positions UI does not fetch this DEX's positions or performance.
   * Omitted or true = fetch when the signer matches (Meteora today; the default must stay unchanged).
   */
  listPositions?: boolean;
};

/** UI-safe description of one DEX: the registry element the UI reads (extends the unified-positions source). */
export type DexDescriptor<N = unknown> = {
  id: DexId;
  chain: ChainId;
  displayName: string;
  meta: DexMeta;
  capabilities: DexCapabilities;
  /** Client-safe UI record. Present on registered venues that have shipped these flags (Meteora today). */
  ui?: DexUi;
  /** Per-position overrides, merged over `capabilities` by `capabilitiesFor` (same rule as unified positions). */
  positionCapabilities?(position: UnifiedPosition<N>): Partial<DexCapabilities>;
};
