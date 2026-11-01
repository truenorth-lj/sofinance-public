/**
 * Unified "My positions" model (design: unified-positions ADAPTER_DESIGN, PR-A). One `PositionSource` per protocol/chain;
 * the UI reads positions and decides which tools to show only from a source's capabilities, never from chain checks.
 * Sources: Raydium CLMM (Solana) and Uniswap v4 on Robinhood Chain.
 */
export type ChainId = "solana" | "robinhood-chain";
/**
 * `"uniswap-v4-rhc"` is the canonical DEX id (`src/lib/dex/types.ts`) that DEX adapters emit; `"rhc-uniswap-v4"` is
 * the legacy spelling the current Robinhood Chain source still uses. Type-only widening, no runtime change.
 * TODO(PR11): drop "rhc-uniswap-v4" together with LEGACY_DEX_ID_ALIASES.
 */
export type PositionSourceId = "raydium-clmm" | "orca-whirlpool" | "meteora-dlmm" | "rhc-uniswap-v4" | "uniswap-v4-rhc";
export type ToolId = "compound" | "performance" | "deposit" | "withdraw";
export const TOOL_IDS: readonly ToolId[] = Object.freeze(["compound", "performance", "deposit", "withdraw"]);

/** Stable, URL-safe key: `${source}:${nativeId}`. */
export type PositionKey = `${PositionSourceId}:${string}`;

export type TokenRef = { id: string; symbol: string | null; decimals: number };

export type RangeView =
  | { mode: "price"; lower: number; upper: number; current: number | null }
  | { mode: "tick"; tickLower: number; tickUpper: number; currentTick: number | null };

export type TokenPairRaw = { a: string; b: string };
export type PositionHoldings = { liquidityRaw: TokenPairRaw | null; unclaimedFeesRaw: TokenPairRaw | null };

export type RangeStatus = "in" | "below" | "above" | "unknown";

export type UnifiedPosition<N = unknown> = {
  key: PositionKey;
  source: PositionSourceId;
  chain: ChainId;
  nativeId: string;
  poolId: string;
  tokenA: TokenRef;
  tokenB: TokenRef;
  range: RangeView;
  rangeStatus: RangeStatus;
  /** Raw liquidity; "0" = closed. */
  liquidity: string;
  valueUsd?: number | null;
  /**
   * Token amounts as raw atomic strings, for sources whose rows the shared panel draws (registry DEXes): what sits in
   * liquidity and the unclaimed fees, per pool token. `null` = could not be read (shown as a dash, never as zero).
   * Sources that draw their own rows (Raydium inline, RHC) leave it out.
   */
  holdings?: PositionHoldings;
  /**
   * Rent (lamports, base-10 string) a full withdraw that closes the position pays back to the wallet, for DEXes whose
   * descriptor says rent is refunded on close. The Withdraw panel states it before the user signs; the step label then
   * repeats the exact amount. Absent when it was not read.
   */
  closeRefundLamports?: string;
  /** The source's own record, passed unchanged to that source's tools. */
  native: N;
};

/** Shown in the UI when a tool is missing for a pool (PM decision 3). */
export const NOT_AVAILABLE_MESSAGE = "Not available for this pool yet";

export type Capability = { supported: true } | { supported: false; reason: string };
export type WithdrawCapability = { supported: true; partial: boolean } | { supported: false; reason: string };

/** What a withdraw can pay out: the pool's own tokens, or everything swapped to USDC or to SOL. */
export type WithdrawOutput = "pool-tokens" | "usdc" | "sol";
export const WITHDRAW_OUTPUTS = ["pool-tokens", "usdc", "sol"] as const satisfies readonly WithdrawOutput[];

export type SourceCapabilities = {
  compound: Capability;
  performance: Capability;
  deposit: Capability;
  withdraw: WithdrawCapability;
  /**
   * Outputs a withdraw can pay out in (PM 11/1). The Withdraw panel offers only these (e.g. "Withdraw to USDC" only when
   * "usdc" is listed); the route refuses any other. Read only while withdraw is supported.
   */
  withdrawOutputs: readonly WithdrawOutput[];
  exitPreview: Capability & { output?: "usdc+sol" | "pool-tokens" };
  rangeDisplay: "price" | "tick";
  manualAdd: boolean;
  signer: "solana-wallet" | "evm-wallet";
};

export type PositionSource<N = unknown, D = unknown> = {
  id: PositionSourceId;
  chain: ChainId;
  displayName: string;
  capabilities: SourceCapabilities;
  /** Map the source's discovery result to unified positions, keeping the source's order. */
  fromDiscovery(discovery: D | null | undefined): UnifiedPosition<N>[];
  /** Dropdown label without the source name or "Closed" (rows.ts adds those). */
  label(position: UnifiedPosition<N>, metadata?: Record<string, { symbol?: string | null } | undefined>): string;
  /**
   * Per-position override (e.g. one pool supports a tool, another does not; a position owned by another wallet cannot be
   * closed). Merged over `capabilities` by `capabilitiesFor`; the UI only ever reads the merged result.
   */
  positionCapabilities?(position: UnifiedPosition<N>): Partial<SourceCapabilities>;
};

export const SUPPORTED: Capability = Object.freeze({ supported: true });
export const unsupported = (reason: string): Capability => Object.freeze({ supported: false, reason });

export function positionKey(source: PositionSourceId, nativeId: string): PositionKey {
  return `${source}:${nativeId}`;
}

// TODO(PR11): add the canonical "uniswap-v4-rhc" here when the RHC adapter emits it (and drop "rhc-uniswap-v4").
const SOURCE_IDS: readonly PositionSourceId[] = ["raydium-clmm", "orca-whirlpool", "meteora-dlmm", "rhc-uniswap-v4"];

export function parsePositionKey(value: string | null | undefined): { source: PositionSourceId; nativeId: string } | null {
  if (!value) return null;
  const at = value.indexOf(":");
  if (at <= 0) return null;
  const source = value.slice(0, at) as PositionSourceId;
  const nativeId = value.slice(at + 1);
  return SOURCE_IDS.includes(source) && nativeId ? { source, nativeId } : null;
}

export function isToolSupported(capabilities: SourceCapabilities, tool: ToolId): boolean {
  return capabilities[tool].supported;
}

/** The reason a tool is unavailable, or null when it is supported. */
export function toolUnavailableReason(capabilities: SourceCapabilities, tool: ToolId): string | null {
  const cap = capabilities[tool];
  return cap.supported ? null : cap.reason;
}

/** The capabilities the UI uses for one position: the source's, with that position's overrides on top. */
export function capabilitiesFor<N>(source: Pick<PositionSource<N>, "capabilities" | "positionCapabilities">, position: UnifiedPosition<N> | null | undefined): SourceCapabilities {
  if (!position || !source.positionCapabilities) return source.capabilities;
  const override = source.positionCapabilities(position);
  return Object.keys(override).length ? { ...source.capabilities, ...override } : source.capabilities;
}

/** First supported tool, in tab order (where a selection lands when its current tool is unavailable). */
export function firstSupportedTool(capabilities: SourceCapabilities): ToolId | null {
  return TOOL_IDS.find((tool) => capabilities[tool].supported) ?? null;
}
