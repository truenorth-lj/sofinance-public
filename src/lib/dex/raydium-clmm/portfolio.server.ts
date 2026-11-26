import "server-only";
import "@/lib/engine-host";
import { rpcConnection } from "@sofinance/engine/rpc";
import { resetRpcCache } from "@sofinance/engine/rpc/cache";
import { readRaydiumPositionAccounts } from "@sofinance/engine/protocols/raydium/position-snapshot";
import { fetchTokenPricesUsd, type TokenPriceQuote } from "@sofinance/engine/token-prices";
import { getTokenMetadata } from "@sofinance/engine/token-metadata";
import { getPositionFigures, fetchRaydiumPoolSymbolsBatch } from "@/lib/position-performance";
import { getRwaConfig } from "@/lib/config/rwa-env";
import { getPositionHistoryStore } from "@/lib/position-history-store";
import { readPortfolioHistory, unavailablePortfolioHistory, type PortfolioHistoryResult } from "@/lib/portfolio/history-snapshot";
import { PositionHistoryStoreError } from "@/lib/position-history-store-types";
import { syncPositionHistory } from "@/lib/position-history-sync";
import { createHistoryRpcConnections } from "@/lib/position-history-rpc";
import type { Connection } from "@solana/web3.js";
import { batchAccountReads, withSharedAccountReads } from "@/lib/portfolio/account-batch";
import type { PortfolioInput, PortfolioRequest, PortfolioReader } from "@/lib/portfolio/model";
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
async function readInputs(positions: PortfolioRequest["positions"], signal: AbortSignal, accounts?: Connection) {
  const snapshotsController = new AbortController();
  const snapshotsSignal = AbortSignal.any([signal, snapshotsController.signal, AbortSignal.timeout(PORTFOLIO_POSITION_DEADLINE_MS)]);
  const snapshotConnection = accountReader(snapshotsSignal, accounts);
  const snapshots = new Map(await mapPortfolioPositions(positions, async (item) => {
    try {
      snapshotsSignal.throwIfAborted();
      const snapshot = await abortable(readRaydiumPositionAccounts(item.key.split(":")[1]!, snapshotConnection), snapshotsSignal);
      return [item.key, snapshot] as const;
    } catch { return [item.key, null] as const; }
  }));
  snapshotsController.abort();
  const mints = [...new Set([...snapshots.values()].flatMap((snapshot) => snapshot ? [snapshot.mintA, snapshot.mintB] : []))];
  const [prices, labels] = await Promise.all([
    mints.length ? abortable(fetchTokenPricesUsd(mints), signal).catch(() => new Map<string, TokenPriceQuote>()) : new Map<string, TokenPriceQuote>(),
    abortable(readSymbols(snapshots), signal).catch(() => new Map<string, Symbols>()),
  ]);
  return { snapshots, prices, labels };
}

/** Account reads for one stage or row: the request's shared batch when given (other DEXes join its waves), else a local one. */
function accountReader(signal: AbortSignal, accounts?: Connection): Connection {
  const connection = rpcConnection(undefined, { signal });
  return accounts ? withSharedAccountReads(accounts, connection, signal) : batchAccountReads(connection, signal);
}

export async function prepareRaydiumPortfolio(input: PortfolioInput, signal: AbortSignal, accounts?: Connection): Promise<PortfolioReader> {
  if (input.fresh || input.positions.some((item) => item.afterSignatures?.length)) resetRpcCache();
  const { snapshots, prices, labels } = await readInputs(input.positions, signal, accounts);
  return async (item, readSignal) => {
    const snapshot = snapshots.get(item.key);
    if (!snapshot) throw new Error("Position accounts unavailable");
    const context = { positionMint: item.key.split(":")[1]!, positionAccount: snapshot.positionAccount,
      poolId: snapshot.poolId, mintA: snapshot.mintA, mintB: snapshot.mintB, vaultA: snapshot.vaultA, vaultB: snapshot.vaultB };
    let store: ReturnType<typeof getPositionHistoryStore> | null = null;
    let history: (PortfolioHistoryResult & { historyError?: string }) | null = null;
    // A history store outage must not blank the row: value and unclaimed fees do not need it. Only the store's own
    // error degrades (cumulative fees stay unknown, the code is carried through); anything else still fails the row.
    try {
      store = input.scheduleHistoryRefresh && getRwaConfig().positionHistoryEnabled ? getPositionHistoryStore() : null;
      history = store ? await readPortfolioHistory({ store, context, fresh: input.fresh,
        refreshAfter: item.refreshAfter, afterSignatures: item.afterSignatures }) : null;
    } catch (error) {
      if (!(error instanceof PositionHistoryStoreError)) throw error;
      store = null;
      history = unavailablePortfolioHistory(error.code);
    }
    readSignal.throwIfAborted();
    if (history?.needsSync) input.scheduleHistoryRefresh!(JSON.stringify(context), async (signal) => {
      const connections = createHistoryRpcConnections(signal);
      await syncPositionHistory({ context, store: store!,
        connection: connections.connection, fallbackConnection: connections.fallbackConnection,
        maxSignatures: 100, maxDetailRequests: 8, signal,
        rpcMetrics: () => connections.observer.snapshot(), receiptProvider: (signature) => connections.observer.receiptProvider(signature),
      });
    });
    // A row deadline cancels its fee transport before the scheduler reuses the slot.
    const connection = accountReader(readSignal, accounts);
    const read = await getPositionFigures(item.key.split(":")[1]!, {
      wallet: input.wallet, snapshot, prices, accountConnection: connection, signal: readSignal,
      symbols: labels.get(snapshot.poolId) ?? { symbolA: null, symbolB: null },
      refreshHistory: input.fresh, historyAfterSignatures: item.afterSignatures,
      historyResult: history?.history,
      // Store outage: valuation must not read the store again either.
      ...(history?.historyError ? { historyStore: null } : {}),
    });
    return { figures: read.figures, unclaimedFeesRaw: read.unclaimedFeesRaw, evaluatedAt: read.evaluatedAt, historyComplete: read.historyComplete,
      historyRefreshResolved: history?.historyRefreshResolved ?? read.historyRefreshResolved,
      historyUpdatedAt: history?.historyUpdatedAt, historyStatus: history?.historyStatus,
      historyRefreshAfter: history?.historyRefreshAfter,
      ...(history?.historyError ? { historyError: history.historyError } : {}),
      timings: { ...read.timings, history: read.historyFetch } };
  };
}
