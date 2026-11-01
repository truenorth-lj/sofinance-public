/**
 * Unified "My positions" model (design: unified-positions ADAPTER_DESIGN, PR-A). One `PositionSource` per protocol/chain;
 * the UI reads positions and decides which tools to show only from a source's capabilities, never from chain checks.
 * PR-A: types + the Raydium CLMM source only; `/app` behaves exactly as before.
 */
export type ChainId = "solana" | "robinhood-chain";
export type PositionSourceId = "raydium-clmm" | "orca-whirlpool" | "meteora-dlmm" | "rhc-uniswap-v4";
export type ToolId = "compound" | "performance" | "deposit" | "withdraw";
export const TOOL_IDS: readonly ToolId[] = Object.freeze(["compound", "performance", "deposit", "withdraw"]);

/** Stable, URL-safe key: `${source}:${nativeId}`. */
export type PositionKey = `${PositionSourceId}:${string}`;

export type TokenRef = { id: string; symbol: string | null; decimals: number };

export type RangeView =
  | { mode: "price"; lower: number; upper: number; current: number | null }
  | { mode: "tick"; tickLower: number; tickUpper: number; currentTick: number | null };

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
  /** The source's own record, passed unchanged to that source's tools. */
  native: N;
};

/** Shown in the UI when a tool is missing for a pool (PM decision 3). */
export const NOT_AVAILABLE_MESSAGE = "Not available for this pool yet";

export type Capability = { supported: true } | { supported: false; reason: string };
export type WithdrawCapability = { supported: true; partial: boolean } | { supported: false; reason: string };

export type SourceCapabilities = {
  compound: Capability;
  performance: Capability;
  deposit: Capability;
  withdraw: WithdrawCapability;
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
};

export const SUPPORTED: Capability = Object.freeze({ supported: true });
export const unsupported = (reason: string): Capability => Object.freeze({ supported: false, reason });

export function positionKey(source: PositionSourceId, nativeId: string): PositionKey {
  return `${source}:${nativeId}`;
}

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
