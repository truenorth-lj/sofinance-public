"use client";

import { ConnectWalletPrompt } from "./connect-wallet-prompt";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle, Search } from "lucide-react";
import { useWalletConnection } from "./wallet-connection";
import {
  parseListedPositions,
  resolveWalletField,
  showUseConnectedWallet,
  type ListedPosition,
} from "../lib/position-performance-form";
import { PositionSelect } from "./position-select";
import { useTokenMetadata } from "./use-token-metadata";
import { DecisionSession } from "@/lib/lp-decision-session";
import { clearPositionHistoryRefresh, readPositionHistoryRefresh, subscribePositionHistoryRefresh } from "@/lib/position-history-refresh";
import { PositionExitEstimate } from "./position-exit-estimate";
import { PerformancePoolChart, PerformanceSummary, type PerformanceResponse } from "./position-performance-summary";

export function PositionPerformancePanel({
  initialMint = "",
  initialWallet = "",
  previewPoolId = "",
  embedded = false,
  selectedMint,
  selectedNftAccount,
  nftAccountPending = false,
}: {
  initialMint?: string;
  initialWallet?: string;
  previewPoolId?: string;
  embedded?: boolean;
  selectedMint?: string;
  selectedNftAccount?: string;
  /** The parent is still resolving the holder's NFT token account (see resolveNftAccountLookup). */
  nftAccountPending?: boolean;
}) {
  const { address, connected, connect } = useWalletConnection();
  const connectedAddress = connected ? address : undefined;
  const [positionChoice, setPositionChoice] = useState<{ value: string; wallet: string | null; sharedMint?: string } | null>(
    initialMint ? { value: initialMint, wallet: null } : null,
  );
  const [manualWallet, setManualWallet] = useState<string | null>(null);
  const [ignoreUrlWallet, setIgnoreUrlWallet] = useState(false);
  const [fetchedPositions, setFetchedPositions] = useState<{
    wallet: string;
    positions: ListedPosition[];
    status: "ready" | "error";
  } | null>(null);
  const [loadedData, setLoadedData] = useState<{ body: PerformanceResponse; context: string } | null>(null);
  const lookup = useRef(new DecisionSession());
  const [error, setError] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState<string | null>(null);
  const walletField = resolveWalletField({
    urlWallet: initialWallet,
    connectedAddress,
    manualValue: manualWallet,
    ignoreUrl: ignoreUrlWallet,
  });
  const wallet = walletField.value;
  const listedPositions =
    fetchedPositions && fetchedPositions.wallet === connectedAddress ? fetchedPositions.positions : [];
  const choiceIsCurrent = positionChoice && (positionChoice.wallet === null || positionChoice.wallet === connectedAddress)
    && (!embedded || positionChoice.sharedMint === selectedMint);
  const positionMint = choiceIsCurrent ? positionChoice.value : selectedMint ?? listedPositions[0]?.positionMint ?? "";
  const context = `${positionMint.trim()}:${wallet.trim()}`;
  const loading = loadingContext === context;
  const decisionMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(positionMint.trim()) ? positionMint.trim() : undefined;
  const data = loadedData?.context === context ? loadedData.body : null;
  const autoLoadSharedPosition = embedded && !choiceIsCurrent && Boolean(decisionMint) && positionMint === selectedMint;
  useEffect(() => { const current = lookup.current; return () => current.cancel(); }, [context]);
  const changePositionMint = (value: string) => {
    lookup.current.cancel();
    setLoadedData(null);
    setLoadingContext(null);
    setError(null);
    setPositionChoice({ value, wallet: connectedAddress ?? null, sharedMint: selectedMint });
  };
  const positionMetadata = useTokenMetadata([...listedPositions.flatMap((item) => [item.mintA, item.mintB]), ...(data ? [data.mintA, data.mintB] : [])]);
  const positionsStatus: "idle" | "loading" | "ready" | "error" = !connectedAddress
    ? "idle"
    : fetchedPositions && fetchedPositions.wallet === connectedAddress
      ? fetchedPositions.status
      : "loading";

  useEffect(() => {
    if (!connectedAddress || embedded) return;
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/wallet?wallet=${encodeURIComponent(connectedAddress)}`, {
            cache: "no-store",
            signal: aborter.signal,
            headers: { Accept: "application/json" },
          });
          const body: unknown = await response.json();
          if (!response.ok) throw new Error("Wallet scan failed");
          if (aborter.signal.aborted) return;
          setFetchedPositions({
            wallet: connectedAddress,
            positions: parseListedPositions(body),
            status: "ready",
          });
        } catch {
          if (!aborter.signal.aborted) {
            setFetchedPositions({ wallet: connectedAddress, positions: [], status: "error" });
          }
        }
      })();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      aborter.abort();
    };
  }, [connectedAddress, embedded]);

  const load = useCallback(async () => {
    const mint = positionMint.trim();
    if (!mint) {
      setError("Enter a position NFT mint");
      return;
    }
    const attempt = lookup.current.begin(); if (!attempt) return;
    setLoadingContext(context);
    setError(null);
    try {
      const params = new URLSearchParams({ positionMint: mint });
      if (wallet.trim()) params.set("wallet", wallet.trim());
      // Continue bounded initial history loading as part of this view, without a scheduler.
      for (let step = 0; step < 5; step++) {
        const refresh = readPositionHistoryRefresh(mint);
        if (refresh) {
          params.set("refreshHistory", "1");
          if (refresh.signatures.length) params.set("historyAfterSignatures", refresh.signatures.join(","));
          else params.delete("historyAfterSignatures");
        } else { params.delete("refreshHistory"); params.delete("historyAfterSignatures"); }
        const response = await fetch(`/api/position-performance?${params}`, {
          signal: attempt.signal,
          headers: { Accept: "application/json" },
        });
        const body = (await response.json()) as PerformanceResponse & { error?: string };
        if (!attempt.current()) return;
        if (!response.ok) throw new Error(body.error || "Lookup failed");
        if (body.positionMint !== mint) throw new Error("Position response mismatch");
        if (refresh && (refresh.signatures.length ? body.historyFetch?.refreshSignaturesResolved === true : !body.truncated)) {
          clearPositionHistoryRefresh(mint, refresh.version);
        }
        setLoadedData({body, context});
        if (!body.truncated || !body.historyFetch?.canContinue) break;
      }
    } catch (err) {
      if (attempt.current()) { setLoadedData(null); setError(err instanceof Error ? err.message : "Lookup failed"); }
    } finally {
      if (attempt.current()) { attempt.finish(); setLoadingContext(null); }
    }
  }, [context, positionMint, wallet]);

  useEffect(() => subscribePositionHistoryRefresh(positionMint.trim(), () => {
    lookup.current.cancel();
    setLoadedData(null);
    void load();
  }), [positionMint, load]);

  useEffect(() => {
    if (!autoLoadSharedPosition) return;
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [autoLoadSharedPosition, load]);

  return (
    <>
    {!embedded && <section className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7 lg:col-span-5" aria-labelledby="perf-heading">
      <h2 id="perf-heading" className="text-base font-semibold text-cream">
        Step 1 · Select a position
      </h2>

      <div className="mt-4 space-y-3">
        {!embedded && connectedAddress && (
          <PositionSelect
            id="perf-position"
            label="Connected wallet positions"
            value={listedPositions.some((item) => item.positionMint === positionMint) ? positionMint : ""}
            disabled={positionsStatus !== "ready" || listedPositions.length === 0}
            onChange={(next) => {
              if (next) changePositionMint(next);
            }}
            positions={listedPositions}
            metadata={positionMetadata}
            placeholder={
              positionsStatus === "loading"
                ? "Loading positions…"
                : positionsStatus === "error"
                  ? "Could not load positions — paste a mint"
                  : listedPositions.length
                    ? "Select a position NFT"
                    : "No CLMM positions on this wallet"
            }
          />
        )}
        {!embedded && !connectedAddress && <ConnectWalletPrompt onConnect={connect} />}
        {positionsStatus === "ready" && listedPositions.length === 0 && <div role="status" className="rounded-2xl border border-white/12 bg-white/[0.03] p-4">
          <p className="font-medium text-cream/90">No positions found in this wallet</p>
          <p className="mt-1 text-xs leading-5 text-smoke">Explore RWA pairs and open a position to start tracking performance.</p>
          <a href="/app/rwa-pairs" className="mt-3 inline-flex items-center gap-2 rounded-full border border-white/20 px-4 py-2 text-sm font-semibold text-cream hover:bg-white/10">Explore RWA Pairs <ArrowUpRight className="h-4 w-4" /></a>
        </div>}
        {!embedded && <details className="rounded-2xl border border-white/10 p-3">
          <summary className="cursor-pointer text-xs font-medium text-smoke">Look up another position by NFT mint</summary>
          <div className="mt-3 space-y-3">
            <label className="block text-xs text-smoke">
              Position mint
              <input
                className="mt-1 w-full rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream focus:border-white/40 focus:outline-none"
                value={positionMint}
                onChange={(event) => changePositionMint(event.target.value)}
                placeholder="Position NFT mint (base58)"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <p className="text-[11px] leading-4 text-smoke/70">
              Paste any position NFT mint
              {connectedAddress ? ", or pick one from the connected wallet." : "."}
            </p>
            <div>
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="perf-wallet" className="text-xs text-smoke">
                  Wallet (optional ownership check)
                </label>
                {showUseConnectedWallet(wallet, connectedAddress) && connectedAddress && (
                  <button
                    type="button"
                    onClick={() => {
                      setManualWallet(null);
                      setIgnoreUrlWallet(true);
                    }}
                    className="text-[11px] font-medium text-smoke transition-colors hover:text-cream/80"
                  >
                    Use connected wallet
                  </button>
                )}
              </div>
              <input
                id="perf-wallet"
                className="mt-1 w-full rounded-2xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream focus:border-white/40 focus:outline-none"
                value={wallet}
                onChange={(event) => setManualWallet(event.target.value)}
                placeholder="Defaults to the connected wallet"
                spellCheck={false}
                autoComplete="off"
              />
              <p className="mt-1 text-[11px] leading-4 text-smoke/70">
                Optional ownership check. Pre-filled from the connected wallet; clear or paste another
                pubkey to override.
              </p>
            </div>
          </div>
        </details>}
        {autoLoadSharedPosition && !error ? (
          (!data || loading) && <div role="status" className="flex items-center gap-2 border-t border-white/10 pt-5 text-sm text-smoke">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Loading performance…
          </div>
        ) : <div className="border-t border-white/10 pt-5">
          {!embedded && <h3 className="text-base font-semibold text-cream">Step 2 · Compute performance</h3>}
          <p className="mb-3 mt-1 text-xs leading-5 text-smoke">Calculate returns and fees for the selected position.</p>
          <button
            type="button"
            onClick={() => { if (!connectedAddress && embedded) { connect(); return; } void load(); }}
            disabled={loading || (!(embedded && !connectedAddress) && !positionMint.trim())}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            {autoLoadSharedPosition ? "Retry performance" : "Compute performance"}
          </button>
        </div>}
      </div>

      {error && (
        <p className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] px-3 py-2 text-sm text-cream/80" role="alert">
          {error}
        </p>
      )}
    </section>}

    {(embedded || data || previewPoolId) && (
    <section aria-label="Performance results" className="rounded-[28px] border border-white/12 bg-char p-5 sm:p-7 lg:col-span-12">
      <h3 className="mb-5 text-base font-semibold text-cream">Performance results</h3>
      {embedded && !data && !error && (
        autoLoadSharedPosition ? <div role="status" className="flex items-center gap-2 text-sm text-smoke">
          <LoaderCircle className="h-4 w-4 animate-spin" />Loading performance…
        </div> : <p className="text-sm text-smoke">{connectedAddress ? "Select a position above to view performance." : "Connect your wallet above to view performance."}</p>
      )}
      {embedded && error && <div className="space-y-3">
        <p role="alert" className="rounded-2xl border border-white/20 bg-white/[0.04] px-3 py-2 text-sm text-cream/80">{error}</p>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-2 rounded-full bg-lemon px-5 py-3 text-sm font-semibold text-ink disabled:opacity-40">
          {loading && <LoaderCircle className="h-4 w-4 animate-spin" />}Retry performance
        </button>
      </div>}

      {data && <PerformanceSummary data={data} embedded={embedded} metadata={positionMetadata}
        loadingRemaining={Boolean(loadingContext)} onLoadRemaining={() => void load()} />}


      {data && decisionMint && <PositionExitEstimate key={decisionMint} positionId={decisionMint} nftAccount={decisionMint === selectedMint ? selectedNftAccount : undefined}
        nftAccountPending={decisionMint === selectedMint && nftAccountPending} autoExit={embedded} poolMints={[data.mintA, data.mintB]} className="mt-5" />}

      {(data?.poolId || previewPoolId) && <PerformancePoolChart poolId={data?.poolId || previewPoolId} data={data} />}
    </section>
    )}
    </>
  );
}
