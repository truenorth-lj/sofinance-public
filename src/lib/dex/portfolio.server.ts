import "server-only";
import { PublicKey } from "@solana/web3.js";
import { rpcConnection } from "@sofinance/engine/rpc";
import { dexRegistry } from "./index";
import { batchAccountReads } from "@/lib/portfolio/account-batch";
import { positionFigures, portfolioTotals } from "@/lib/portfolio/figures";
import type { PortfolioPosition, PortfolioReader, PortfolioInput, PortfolioResponse } from "@/lib/portfolio/model";
import { mapPortfolioPositions, portfolioAbortable, PORTFOLIO_POSITION_DEADLINE_MS } from "./portfolio-workers";

export async function readPortfolio(input: PortfolioInput, signal: AbortSignal): Promise<PortfolioResponse> {
  const started = Date.now();
  const positions = [...new Map(input.positions.map((item) => [item.key, item])).values()];
  const groups = new Map<string, PortfolioInput["positions"]>();
  for (const item of positions) {
    const source = item.key.split(":")[0]!;
    groups.set(source, [...(groups.get(source) ?? []), item]);
  }
  // One account batch per request: every DEX's position, pool and tick/bin reads share getMultipleAccounts waves.
  const accounts = batchAccountReads(rpcConnection(undefined, { signal }), signal);
  // Every DEX's first round (position accounts) in one getMultipleAccounts, issued before any reader's lazy import;
  // readers then get these from the batch cache. Best effort: a failure is not cached and each reader retries.
  const firstRound = (await Promise.all([...groups].map(([source, items]) => dexRegistry.portfolioAccountKeys(source,
    items.map((item) => item.key.slice(item.key.indexOf(":") + 1))).catch(() => [] as string[])))).flat();
  const firstKeys = firstRound.flatMap((address) => { try { return [new PublicKey(address)]; } catch { return []; } });
  if (firstKeys.length && !signal.aborted) void accounts.getMultipleAccountsInfo(firstKeys, "confirmed").catch(() => {});
  const readers = new Map(await mapPortfolioPositions([...groups], async ([source, items]) => {
    try {
      signal.throwIfAborted();
      return [source, await portfolioAbortable(dexRegistry.preparePortfolio(source, { ...input, positions: items }, signal, accounts), signal)] as const;
    } catch { return [source, null] as const; }
  }));
  const timings: Record<string, unknown> = {};
  const results = await mapPortfolioPositions(positions, async (item): Promise<PortfolioPosition> => {
    const rowController = new AbortController();
    const rowSignal = AbortSignal.any([signal, rowController.signal, AbortSignal.timeout(PORTFOLIO_POSITION_DEADLINE_MS)]);
    const reader: PortfolioReader | null | undefined = readers.get(item.key.split(":")[0]!);
    try {
      rowSignal.throwIfAborted();
      if (!reader) throw new Error("Position source unavailable");
      const result = await portfolioAbortable(reader(item, rowSignal), rowSignal);
      const { figures, unclaimedFeesRaw, evaluatedAt, historyComplete, historyRefreshResolved, historyUpdatedAt, historyStatus, historyRefreshAfter } = result;
      if (result.timings) timings[item.key] = result.timings;
      const complete = historyComplete && [figures.valueUsd, figures.unclaimedFeesUsd, figures.cumulativeFeesUsd].every((value) => value !== null);
      return { key: item.key, status: complete ? "ready" : "partial", figures, ...(unclaimedFeesRaw ? { unclaimedFeesRaw } : {}), evaluatedAt, historyComplete, historyRefreshResolved, historyUpdatedAt, historyStatus, historyRefreshAfter };
    } catch {
      return { key: item.key, status: "failed", figures: positionFigures(null), evaluatedAt: null, historyComplete: false, historyRefreshResolved: false };
    } finally {
      // Promise.all rejection does not cancel siblings; abort them before refilling the worker slot.
      rowController.abort();
    }
  });
  return { wallet: input.wallet, positions: results, totals: portfolioTotals(results.map((result) => result.status === "failed"
    ? { status: "failed" } : { status: "ready", figures: result.figures, historyStatus: result.historyStatus })), timings: { totalMs: Date.now() - started, positions: timings } };
}
