import { uiFor } from "@/lib/dex/ui";
import type { RhcPoolSummary, RhcPoolView } from "@/lib/evm-client-types";
export type { RhcPoolSummary } from "@/lib/evm-client-types";
import type { UnifiedPool, UnifiedProtocol } from "./model";

/** The fields `/api/rwa-pairs` and `/api/protocol-pools` (Orca / Meteora) rows share. */
export type SolanaPoolRow = {
  poolAddress: string;
  protocol?: string;
  mintA: string;
  mintB: string;
  symbolA: string;
  symbolB: string;
  nameA: string;
  nameB: string;
  wrappedSymbol: string;
  plainSymbol: string;
  feeTierBps: number | null;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  estimatedFeeAprPct: number | null;
  priceBPerA?: number | null;
  multiplierA?: number;
  multiplierB?: number;
  token2022A: boolean;
  token2022B: boolean;
  freezeRisk: boolean;
  /** Token settings opening does not handle yet (`/api/rwa-pairs` rows: `unsupported`). */
  unsupported?: { issues: string[]; mints?: string[] };
};

const SOLANA_PROTOCOLS = new Set<UnifiedProtocol>(["raydium-clmm", "orca-whirlpool", "meteora-dlmm"]);

export function solanaPool(row: SolanaPoolRow): UnifiedPool {
  const protocol = (SOLANA_PROTOCOLS.has(row.protocol as UnifiedProtocol) ? row.protocol : "raydium-clmm") as UnifiedProtocol;
  return {
    key: `solana:${row.poolAddress}`,
    chain: "solana",
    protocol,
    poolAddress: row.poolAddress,
    pairLabel: `${row.wrappedSymbol}/${row.plainSymbol}`,
    symbolA: row.symbolA,
    symbolB: row.symbolB,
    nameA: row.nameA,
    nameB: row.nameB,
    mintA: row.mintA,
    mintB: row.mintB,
    feeTierBps: row.feeTierBps,
    tvlUsd: row.tvlUsd,
    volume24hUsd: row.volume24hUsd,
    poolFeeApr24hPct: row.estimatedFeeAprPct,
    ...(row.priceBPerA !== undefined && row.priceBPerA !== null ? { priceBPerA: row.priceBPerA } : {}),
    ...(row.multiplierA !== undefined ? { multiplierA: row.multiplierA } : {}),
    ...(row.multiplierB !== undefined ? { multiplierB: row.multiplierB } : {}),
    ...(row.unsupported?.issues.length ? { unsupportedIssues: row.unsupported.issues } : {}),
  };
}

/** Existing RHC callers resolve their pure presentation policy from the registered descriptor. */
export function rhcPairLabel(poolId: string, separator = "/"): string | null {
  return uiFor("uniswap-v4-rhc").nativePoolPresentation?.pairLabel(poolId, separator) ?? null;
}

export function rhcPool(summary: RhcPoolSummary): UnifiedPool | null {
  return uiFor("uniswap-v4-rhc").nativePoolPresentation?.pool(summary) ?? null;
}

export function rhcPoolView(summary: RhcPoolSummary): RhcPoolView | null {
  return uiFor("uniswap-v4-rhc").nativePoolPresentation?.openView(summary) ?? null;
}
