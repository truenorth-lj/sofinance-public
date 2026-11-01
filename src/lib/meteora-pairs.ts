import "server-only";

import { PublicKey, type Connection } from "@solana/web3.js";
import { decodeLbPair } from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_DLMM_PROGRAM_ID, SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, type MeteoraAllowlistedPool, type MeteoraPoolSpec } from "@sofinance/engine/protocols/meteora/constants";
import { rpcConnection } from "@sofinance/engine/rpc";
import { fetchMeteoraPools, type FetchMeteoraPoolsOptions, type MeteoraPoolSummary } from "@sofinance/engine/protocols/meteora/discovery";
import { estimateFeeAprPct, FEE_APR_ESTIMATE_LABEL, isToken2022Program } from "./rwa-pairing";
import { readMintFreezeAuthorities } from "./onchain-mint-freeze";
import type { RwaPairRow } from "./rwa-pairs";

/** On-chain facts that override Meteora's datapi in the rows. */
export type MeteoraOnchainFacts = {
  /** LbPair `protocol_share`, basis points of the swap fee kept by Meteora, by pool address. */
  protocolShareBps: ReadonlyMap<string, number>;
  /** Mint freeze authority still set, by mint. */
  freezeAuthority: ReadonlyMap<string, boolean>;
  /** Token program owning each mint (scan-found pools, whose spec does not pin it). */
  tokenProgram?: ReadonlyMap<string, string>;
};

const NO_FACTS: MeteoraOnchainFacts = { protocolShareBps: new Map(), freezeAuthority: new Map() };

/**
 * Read-only Meteora DLMM rows in the `/api/rwa-pairs` row shape (protocol "meteora-dlmm").
 * Row A/B are Meteora token X/Y. Rows cannot be opened yet.
 */
export function meteoraPairRow(pool: MeteoraPoolSummary, facts?: MeteoraOnchainFacts): RwaPairRow;
/** A pool the scan found: the pairing identity comes from the registry match instead of the allowlist. */
export function meteoraPairRow(pool: MeteoraPoolSummary<MeteoraPoolSpec>, facts: MeteoraOnchainFacts, identity: MeteoraRowIdentity): RwaPairRow;
export function meteoraPairRow(pool: MeteoraPoolSummary<MeteoraPoolSpec>, facts: MeteoraOnchainFacts = NO_FACTS, identity?: MeteoraRowIdentity): RwaPairRow {
  const id: MeteoraRowIdentity = identity ?? allowlistIdentity(pool.spec as MeteoraAllowlistedPool);
  const tokenProgramX = pool.spec.tokenProgramX, tokenProgramY = pool.spec.tokenProgramY;
  // Freeze risk: the mint's on-chain freeze authority; Meteora's datapi flag only when the chain read failed.
  const freezeRiskA = facts.freezeAuthority.get(pool.mintX) ?? pool.freezeAuthorityDisabledX === false;
  const freezeRiskB = facts.freezeAuthority.get(pool.mintY) ?? pool.freezeAuthorityDisabledY === false;
  // LP share of the gross 24h fees with the on-chain protocol share; datapi's protocol fees only as a fallback.
  const shareBps = facts.protocolShareBps.get(pool.poolAddress);
  const lpFees24hUsd = shareBps !== undefined && pool.fees24hUsd !== null
    ? pool.fees24hUsd * (1 - shareBps / 10_000)
    : pool.lpFees24hUsd;
  return {
    poolAddress: pool.poolAddress,
    protocol: "meteora-dlmm",
    mintA: pool.mintX,
    mintB: pool.mintY,
    symbolA: pool.symbolX || id.wrappedSymbol,
    symbolB: pool.symbolY || id.plainSymbol,
    nameA: pool.nameX,
    nameB: pool.nameY,
    baseSymbol: id.baseSymbol,
    wrappedSymbol: id.wrappedSymbol,
    plainSymbol: id.plainSymbol,
    wrapKind: id.wrapKind,
    relatedness: id.relatedness,
    qualificationA: id.qualificationA,
    qualificationB: id.qualificationB,
    preferredTags: id.preferredTags,
    jupiterTagsA: id.jupiterTagsA,
    jupiterTagsB: id.jupiterTagsB,
    feeRate: pool.baseFeeRate,
    feeTierBps: pool.baseFeeBps,
    tvlUsd: pool.tvlUsd,
    volume24hUsd: pool.volume24hUsd,
    // LP share (gross fees minus Meteora's on-chain protocol share).
    fees24hUsd: lpFees24hUsd,
    raydiumFeeApr24h: null,
    estimatedFeeAprPct: pool.tvlUsd !== null && lpFees24hUsd !== null ? estimateFeeAprPct(lpFees24hUsd, pool.tvlUsd) : null,
    estimatedFeeAprLabel: FEE_APR_ESTIMATE_LABEL,
    token2022A: isToken2022Program(tokenProgramX ?? facts.tokenProgram?.get(pool.mintX) ?? ""),
    token2022B: isToken2022Program(tokenProgramY ?? facts.tokenProgram?.get(pool.mintY) ?? ""),
    freezeRiskA,
    freezeRiskB,
    freezeRisk: freezeRiskA || freezeRiskB,
    ...(identity ? { binStep: pool.binStep, poolCreatedAt: pool.createdAt } : {}),
  };
}

/** Pairing fields of a Meteora row (allowlist spec, or the scan's registry match). */
export type MeteoraRowIdentity = Pick<RwaPairRow, "baseSymbol" | "wrappedSymbol" | "plainSymbol" | "wrapKind" | "relatedness" |
  "qualificationA" | "qualificationB" | "preferredTags" | "jupiterTagsA" | "jupiterTagsB">;

function allowlistIdentity(spec: MeteoraAllowlistedPool): MeteoraRowIdentity {
  return { baseSymbol: spec.baseSymbol, wrappedSymbol: spec.wrappedSymbol, plainSymbol: spec.plainSymbol, wrapKind: "same-asset",
    relatedness: "allowlisted", qualificationA: "allowlist", qualificationB: "allowlist", preferredTags: false, jupiterTagsA: [], jupiterTagsB: [] };
}

export type MeteoraPairsResult = {
  protocol: "meteora-dlmm";
  readOnly: true;
  pairs: RwaPairRow[];
  fetchedAt: string;
  source: string;
  /** Where the protocol share and freeze risk came from: chain, or the datapi when the chain read failed. */
  onchainSource: "onchain" | "datapi";
};

/**
 * One batched read of each pool's LbPair (protocol share and token programs; owner, mints and bin step checked
 * against the spec) and one of their mints (freeze authority). Anything that fails a check is left out (datapi
 * fallback). Reads at most 100 accounts per call.
 */
export async function readMeteoraOnchainFacts(connection: Connection, pools: readonly MeteoraPoolSummary<MeteoraPoolSpec>[]): Promise<MeteoraOnchainFacts> {
  const protocolShareBps = new Map<string, number>(), tokenProgram = new Map<string, string>();
  if (pools.length === 0) return { protocolShareBps, freezeAuthority: new Map(), tokenProgram };
  const readPools = async () => {
    const infos: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>> = [];
    for (let start = 0; start < pools.length; start += 100)
      infos.push(...await connection.getMultipleAccountsInfo(pools.slice(start, start + 100).map((pool) => new PublicKey(pool.poolAddress)), "confirmed"));
    return infos;
  };
  const [infos, freezeAuthority] = await Promise.all([
    readPools(),
    readMintFreezeAuthorities(connection, pools.flatMap((pool) => [pool.mintX, pool.mintY])),
  ]);
  infos.forEach((info, index) => {
    const pool = pools[index]!;
    if (!info || info.owner.toBase58() !== METEORA_DLMM_PROGRAM_ID) return;
    try {
      const state = decodeLbPair(info.data);
      if (state.tokenXMint !== pool.spec.mintX || state.tokenYMint !== pool.spec.mintY || state.binStep !== pool.spec.binStep) return;
      if (state.protocolShare > 10_000) return;
      protocolShareBps.set(pool.poolAddress, state.protocolShare);
      const program = (flag: number) => (flag === 0 ? SPL_TOKEN_PROGRAM_ID : flag === 1 ? TOKEN_2022_PROGRAM_ID : null);
      const programX = program(state.tokenProgramFlagX), programY = program(state.tokenProgramFlagY);
      if (programX) tokenProgram.set(pool.mintX, programX);
      if (programY) tokenProgram.set(pool.mintY, programY);
    } catch { /* left out */ }
  });
  return { protocolShareBps, freezeAuthority, tokenProgram };
}

const CACHE_TTL_MS = 60_000;
let cache: { at: number; result: MeteoraPairsResult } | null = null;

export async function discoverMeteoraPairs(
  options: FetchMeteoraPoolsOptions & { bypassCache?: boolean; connection?: Connection } = {},
): Promise<MeteoraPairsResult> {
  if (!options.bypassCache && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;
  const pools = await fetchMeteoraPools(options);
  let facts = NO_FACTS;
  try {
    if (pools.length > 0) facts = await readMeteoraOnchainFacts(options.connection ?? rpcConnection(), pools);
  } catch { /* RPC down: fall back to the datapi */ }
  const onchain = pools.every((pool) => facts.protocolShareBps.has(pool.poolAddress) &&
    facts.freezeAuthority.has(pool.mintX) && facts.freezeAuthority.has(pool.mintY));
  const result: MeteoraPairsResult = {
    protocol: "meteora-dlmm",
    readOnly: true,
    pairs: pools.map((pool) => meteoraPairRow(pool, facts)),
    fetchedAt: new Date().toISOString(),
    source: "https://dlmm.datapi.meteora.ag/pools/{address} (allowlist: cbBTC/WBTC); Solana RPC: LbPair protocol share, mint freeze authority",
    onchainSource: onchain ? "onchain" : "datapi",
  };
  if (!options.bypassCache) cache = { at: Date.now(), result };
  return result;
}
