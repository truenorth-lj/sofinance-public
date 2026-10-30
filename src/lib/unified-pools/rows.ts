import { rhcTokenControls, UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { Univ4PoolSummary } from "@sofinance/engine/protocols/uniswap-v4/discovery";
import type { RhcPoolView } from "@/components/rhc-univ4-open-panel";
import type { RhcPoolApr7d } from "@/lib/rhc-univ4-apr7d";
import type { RiskFlag, UnifiedPool, UnifiedProtocol } from "./model";

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
  token2022A: boolean;
  token2022B: boolean;
  freezeRisk: boolean;
};

const SOLANA_PROTOCOLS = new Set<UnifiedProtocol>(["raydium-clmm", "orca-whirlpool", "meteora-dlmm"]);

export function solanaPool(row: SolanaPoolRow): UnifiedPool {
  const protocol = (SOLANA_PROTOCOLS.has(row.protocol as UnifiedProtocol) ? row.protocol : "raydium-clmm") as UnifiedProtocol;
  const risks: RiskFlag[] = [];
  if (row.freezeRisk) risks.push("freeze");
  if (row.token2022A || row.token2022B) risks.push("token-2022");
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
    risks,
  };
}

/** The subset of `Univ4PoolSummary` the list needs (the client gets it from `/api/protocol-pools?protocol=uniswap-v4-rhc`). */
export type RhcPoolSummary = Pick<Univ4PoolSummary, "poolId" | "status" | "tick" | "price" | "estimatedApr" | "warnings"> & {
  token0: Pick<Univ4PoolSummary["token0"], "name" | "symbol">;
  token1: Pick<Univ4PoolSummary["token1"], "name" | "symbol">;
  /** Optional so an older payload still renders (then the reviewed controls decide the freeze flag). */
  freezeRisk?: boolean;
  tokenControls?: Pick<Univ4PoolSummary["tokenControls"][number], "symbol" | "powers" | "paused" | "reviewed">[];
  estimatedApr7d?: Pick<RhcPoolApr7d, "estimatedPoolFeeAprPct" | "attribution"> | null;
};

const POWER_WORDS: Record<string, string> = {
  pause: "pause all transfers", blocklist: "block wallets from sending or receiving", "admin-burn": "remove tokens from any wallet", upgradeable: "change the token contract",
};

/** "SPCX and SPCXon issuers can …" from the on-chain review (docs/rhc-token-permissions.md). */
function freezeNote(controls: NonNullable<RhcPoolSummary["tokenControls"]>): string {
  const withPowers = controls.filter(c => c.powers.length > 0);
  const powers = [...new Set(withPowers.flatMap(c => c.powers))].map(power => POWER_WORDS[power] ?? power);
  const who = withPowers.map(c => c.symbol).join(" and ");
  const list = powers.length > 1 ? `${powers.slice(0, -1).join(", ")} and ${powers.at(-1)}` : powers[0] ?? "";
  const unconfirmed = controls.filter(c => !c.reviewed).map(c => c.symbol);
  return [
    withPowers.length ? `The ${who} issuer${withPowers.length > 1 ? "s" : ""} can ${list} (checked on-chain), like a Solana freeze authority.` : "",
    unconfirmed.length ? `${unconfirmed.join(" and ")} controls could not be confirmed right now.` : "",
  ].filter(Boolean).join(" ");
}

export const NEW_CHAIN_NOTE = "Robinhood Chain is new: fewer pools and a shorter trading history than Solana. Not a problem found in this pool.";

const specFor = (poolId: string) => UNIV4_RHC_ALLOWLISTED_POOLS.find((spec) => spec.poolId.toLowerCase() === poolId.toLowerCase()) ?? null;

/** Robinhood Chain row; null for a pool that is not on the reviewed allowlist or is delisted (it cannot be opened). */
export function rhcPool(summary: RhcPoolSummary): UnifiedPool | null {
  const spec = specFor(summary.poolId);
  if (!spec || summary.status !== "listed") return null;
  const apr = summary.estimatedApr;
  const controls = Array.isArray(summary.tokenControls) ? summary.tokenControls
    : [spec.currency0, spec.currency1].map(token => ({ symbol: token.symbol, powers: [...(rhcTokenControls(token.address)?.powers ?? [])], paused: null, reviewed: true }));
  const freeze = typeof summary.freezeRisk === "boolean" ? summary.freezeRisk : controls.some(c => c.powers.length > 0);
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  // Never "No flags" for this chain: a neutral "New chain" label first, then the same flags Solana pools get.
  const risks: RiskFlag[] = ["new-chain"];
  if (freeze) risks.push("freeze");
  if (warnings.length > 0) risks.push("pool-warning");
  const apr7d = summary.estimatedApr7d ?? null;
  return {
    key: `robinhood:${spec.poolId.toLowerCase()}`,
    chain: "robinhood",
    protocol: "uniswap-v4-rhc",
    poolAddress: spec.poolId,
    pairLabel: `${spec.currency0.symbol}/${spec.currency1.symbol}`,
    symbolA: spec.currency0.symbol,
    symbolB: spec.currency1.symbol,
    nameA: summary.token0?.name || spec.currency0.symbol,
    nameB: summary.token1?.name || spec.currency1.symbol,
    mintA: spec.currency0.address,
    mintB: spec.currency1.address,
    feeTierBps: null,
    tvlUsd: apr?.tvlUsd ?? null,
    volume24hUsd: apr?.volume24hUsd ?? null,
    poolFeeApr24hPct: apr?.estimatedPoolFeeAprPct ?? null,
    poolFeeApr7dPct: apr7d?.estimatedPoolFeeAprPct ?? null,
    attribution: apr7d?.attribution ?? apr?.attribution ?? null,
    risks,
    riskNotes: {
      "new-chain": NEW_CHAIN_NOTE,
      ...(freeze ? { freeze: freezeNote(controls) } : {}),
      ...(warnings.length ? { "pool-warning": warnings.join("; ") } : {}),
    },
  };
}

/** What `RhcUniv4OpenPanel` needs, built from the same discovery payload (null when the pool is not openable). */
export function rhcPoolView(summary: RhcPoolSummary): RhcPoolView | null {
  const spec = specFor(summary.poolId);
  if (!spec) return null;
  return {
    poolId: spec.poolId, status: summary.status, tick: summary.tick, price: summary.price, estimatedApr: summary.estimatedApr,
    token0: { address: spec.currency0.address, symbol: spec.currency0.symbol, decimals: spec.currency0.decimals },
    token1: { address: spec.currency1.address, symbol: spec.currency1.symbol, decimals: spec.currency1.decimals },
  };
}
