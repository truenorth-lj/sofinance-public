import "server-only";
import "@/lib/engine-host";
import { rpcConnection } from "@sofinance/engine/rpc";
import { resetRpcCache } from "@sofinance/engine/rpc/cache";
import { readRaydiumPositionAccounts } from "@sofinance/engine/protocols/raydium/position-snapshot";
import { fetchTokenPricesUsd, type TokenPriceQuote } from "@sofinance/engine/token-prices";
import { getTokenMetadata } from "@sofinance/engine/token-metadata";
import { getPositionFigures, fetchRaydiumPoolSymbolsBatch } from "@/lib/position-performance";
import { batchAccountReads } from "@/lib/portfolio/account-batch";
import type { PortfolioRequest, PortfolioReader } from "@/lib/portfolio/model";
import { mapPortfolioPositions, portfolioAbortable as abortable, PORTFOLIO_POSITION_DEADLINE_MS } from "../portfolio-workers";

type Snapshot = Awaited<ReturnType<typeof readRaydiumPositionAccounts>>;
type Symbols = { symbolA: string | null; symbolB: string | null };

async function readSymbols(snapshots: ReadonlyMap<string, Snapshot | null>): Promise<Map<string, Symbols>> {
  const pools = await fetchRaydiumPoolSymbolsBatch([...new Set([...snapshots.values()].flatMap((snapshot) => snapshot ? [snapshot.poolId] : []))]);
  const missing = [...new Set([...snapshots.values()].flatMap((snapshot) => {
    if (!snapshot) return [];
    const pair = pools.get(snapshot.poolId);
    return [...(!pair?.symbolA ? [snapshot.mintA] : []), ...(!pair?.symbolB ? [snapshot.mintB] : [])];
  }))];
  const metadata = missing.length ? await getTokenMetadata(missing) : {};
  return new Map([...snapshots.values()].flatMap((snapshot) => snapshot ? [[snapshot.poolId, {
    symbolA: pools.get(snapshot.poolId)?.symbolA ?? metadata[snapshot.mintA]?.symbol ?? null,
    symbolB: pools.get(snapshot.poolId)?.symbolB ?? metadata[snapshot.mintB]?.symbol ?? null,
  }] as const] : []));
}

/** Stage accounts first, then share one price/metadata lookup for every distinct token. */
async function readInputs(positions: PortfolioRequest["positions"], signal: AbortSignal) {
  const connection = batchAccountReads(rpcConnection(undefined, { signal }));
  const snapshots = new Map(await mapPortfolioPositions(positions, async (item) => {
    try {
      signal.throwIfAborted();
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(PORTFOLIO_POSITION_DEADLINE_MS)]);
      const snapshot = await abortable(readRaydiumPositionAccounts(item.key.split(":")[1]!, connection), deadline);
      return [item.key, snapshot] as const;
    } catch { return [item.key, null] as const; }
  }));
  const mints = [...new Set([...snapshots.values()].flatMap((snapshot) => snapshot ? [snapshot.mintA, snapshot.mintB] : []))];
  const [prices, labels] = await Promise.all([
    mints.length ? abortable(fetchTokenPricesUsd(mints), signal).catch(() => new Map<string, TokenPriceQuote>()) : new Map<string, TokenPriceQuote>(),
    abortable(readSymbols(snapshots), signal).catch(() => new Map<string, Symbols>()),
  ]);
  return { connection, snapshots, prices, labels };
}


export async function prepareRaydiumPortfolio(input: PortfolioRequest, signal: AbortSignal): Promise<PortfolioReader> {
  if (input.fresh || input.positions.some((item) => item.afterSignatures?.length)) resetRpcCache();
  const { connection, snapshots, prices, labels } = await readInputs(input.positions, signal);
  return async (item, readSignal) => {
    const snapshot = snapshots.get(item.key);
    if (!snapshot) throw new Error("Position accounts unavailable");
    const read = await getPositionFigures(item.key.split(":")[1]!, {
      wallet: input.wallet, snapshot, prices, accountConnection: connection, signal: readSignal,
      symbols: labels.get(snapshot.poolId) ?? { symbolA: null, symbolB: null },
      refreshHistory: input.fresh, historyAfterSignatures: item.afterSignatures,
    });
    return { figures: read.figures, evaluatedAt: read.evaluatedAt, historyComplete: read.historyComplete,
      historyRefreshResolved: read.historyRefreshResolved, timings: { ...read.timings, history: read.historyFetch } };
  };
}
