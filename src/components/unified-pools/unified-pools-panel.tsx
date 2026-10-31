"use client";
import "@/lib/engine-host";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { LayoutGrid, List, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { HIGHEST_RANGE_APR_7D_HELP, POOL_FEE_APR_24H_HELP } from "@/lib/apr-labels/copy";
import { exactAprTitle } from "@/lib/apr-labels/format-apr";
import { cn } from "@/lib/cn";
import { buildPlanPath, DOCS_ROUTES } from "@/lib/public-urls";
import { volumeDivergenceNote } from "@/lib/apr-labels/volume-divergence";
import { HIGHEST_RANGE_COLUMN_LABEL, HIGHEST_RANGE_HELP } from "@/lib/range-apr/copy";
import { unavailableReasonText } from "@/lib/range-apr/format";
import { pairIssuerLabel } from "@/lib/rwa-pair-names";
import type { TokenIconMap } from "@/lib/token-icons/map";
import { fetchRwaPairsList } from "@/lib/rwa-pairs-list";
import { updatedLabel, type SnapshotSourceTime } from "@/lib/snapshot-updated";
import {
  CHAIN_LABELS, DEFAULT_FILTERS, DEFAULT_SORT, FIRST_CLICK_DIR, PROTOCOL_LABELS, selectPools, TVL_FILTER_PRESETS,
  type PoolChain, type PoolFilters, type SortKey, type UnifiedPool, type UnifiedProtocol,
} from "@/lib/unified-pools/model";
import { rhcPool, rhcPoolView, solanaPool, type RhcPoolSummary, type SolanaPoolRow } from "@/lib/unified-pools/rows";
import { InfoTip } from "../info-tip";
import { PairTokenIcons } from "../pair-token-icons";
import { OpenPositionModal } from "../open-position-modal";
import { clearPoolRangeAprClientCache } from "../range-apr/pool-range-apr-client";
import type { RhcPoolView } from "../rhc-univ4-open-panel";
import type { OpenPositionPair } from "../use-open-position-controller";
import { useWalletConnection } from "../wallet-connection";
import { usePoolsApr7d, type Apr7dState } from "./use-pools-apr7d";
import { APR24H_SHORT, APR7D_SHORT, Apr7dValue, ChainBadge, chip, COLUMNS, iconPair, money, OpenButton, PoolTable, pct, type OpenAction } from "./pool-list";

/** Which sources this deployment may show; computed from the code flags on the server and passed down. */
export type UnifiedPoolFlags = {
  orca: boolean;
  meteora: boolean;
  /** Meteora open flow page (`/app/meteora`) exists on this deployment. */
  meteoraOpen: boolean;
  rhc: boolean;
};

type Source = "raydium" | "orca" | "meteora" | "rhc";
const SOURCE_ERROR: Record<Source, string> = {
  raydium: "Raydium pools could not be loaded right now. Refresh to try again.",
  orca: "Orca pools could not be loaded right now.",
  meteora: "Meteora pools could not be loaded right now.",
  rhc: "Robinhood Chain pools could not be loaded right now. SoFinance could not reach the chain or its price source.",
};

/** `icons`: token icon links stored by the daily refresh, served with `/api/rwa-pairs` (`tokenIcons`). */
/** `updated`: when each chain's saved list was written (`fetchedAt`), for the "Updated … UTC" line. */
type Loaded = { rows: SolanaPoolRow[]; rhc: RhcPoolSummary[]; icons?: TokenIconMap; updated: SnapshotSourceTime[] };

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

const NOT_GUARANTEED = "Estimates, not guaranteed.";
const raydiumPoolUrl = (poolId: string) => `https://raydium.io/clmm/create-position/?pool_id=${poolId}`;
const cardEyebrow = "font-data text-[10px] uppercase tracking-[0.12em] text-ink/60";

/**
 * One pool as a cream card (the `/app/rwa-pairs` card fields, now for both chains): token icons and issuer names, the
 * estimated highest range APR (7-day) with the range it comes from ("Highest range", the same range the Create position
 * modal calls Best), when the data was updated, confidence and volume notes in the tooltip, then TVL, volume, fee and
 * 24h pool fee APR. Solana Raydium pools also link "Plan this pool" and the pool on Raydium.
 */
function PoolCard({ pool, apr, action, icons }: {
  pool: UnifiedPool; apr: Apr7dState | undefined; action: OpenAction; icons: TokenIconMap | undefined;
}) {
  const ready = apr?.status === "ready" ? apr : null;
  const volumeNote = ready ? volumeDivergenceNote(pool.volume24hUsd, ready.avgDailyVolumeUsd) : null;
  const withVolumeNote = (text: string) => (volumeNote ? `${text} ${volumeNote}` : text);
  const freshness = apr && apr.status !== "loading" ? apr.freshness : undefined;
  const raydium = pool.protocol === "raydium-clmm";
  return <li className="flex min-w-0 flex-col rounded-[28px] bg-cream p-6 text-ink" data-pool={pool.key}>
    <div className="flex flex-wrap items-center gap-1.5"><ChainBadge chain={pool.chain} /><span className={cn(chip, "border border-ink/25")}>{PROTOCOL_LABELS[pool.protocol]}</span></div>
    <div className="mt-4 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <PairTokenIcons pair={iconPair(pool)} icons={icons} chain={pool.chain} iconClassName="h-10 w-10" />
        <div className="min-w-0">
          <h3 className="text-xl font-medium tracking-[-0.02em]">{pool.pairLabel}</h3>
          <p className="truncate text-xs text-ink/65" title={`${pool.nameA} / ${pool.nameB}`}>{pairIssuerLabel(pool.nameA, pool.nameB)}</p>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <Apr7dValue state={apr} />
        <p className={cn("mt-1.5 flex items-center justify-end gap-1", cardEyebrow)}>
          {APR7D_SHORT}
          {ready && <InfoTip label="About Est. highest range APR" tone="light">
            {withVolumeNote(HIGHEST_RANGE_APR_7D_HELP)}{ready.lowConfidence ? " Low confidence for this pool: thin or patchy recent trading." : ""}
          </InfoTip>}
          {apr?.status === "missing" && apr.degraded && <InfoTip label="About Est. highest range APR" tone="light">{unavailableReasonText("degraded-data")}.</InfoTip>}
        </p>
      </div>
    </div>
    {apr?.status === "missing" && <p className="mt-2 text-xs text-ink/60">{apr.reason}</p>}
    {freshness && <p className="mt-2 text-xs text-ink/60" data-testid="apr-freshness">
      Updated {new Date(freshness.snapshotAt).toLocaleString()}{freshness.delayed && " · Data delayed"}
    </p>}
    {pool.chain === "solana" && <div className="mt-4">
      <p className={cn("flex items-center gap-1", cardEyebrow)}>
        {HIGHEST_RANGE_COLUMN_LABEL}
        {ready && <InfoTip label="About Highest range" placement="above" tone="light">{HIGHEST_RANGE_HELP}</InfoTip>}
      </p>
      <span data-testid="highest-range" className={cn("mt-1.5 inline-block max-w-full truncate rounded-full px-3 py-1 align-top text-sm font-medium", ready ? "bg-lilac" : "bg-ink/10")}>
        {ready ? ready.rangeLabel : apr?.status === "missing" ? "—" : "…"}
      </span>
    </div>}
    <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-ink/20 pt-4">
      <div><dt className={cn("flex items-center gap-1", cardEyebrow)}>{APR24H_SHORT}<InfoTip label="About Est. pool fee APR" placement="above" tone="light">{withVolumeNote(POOL_FEE_APR_24H_HELP)}</InfoTip></dt>
        <dd className="mt-1 font-semibold tabular-nums" data-testid="pool-fee-apr" title={exactAprTitle(pool.poolFeeApr24hPct)}>{pct(pool.poolFeeApr24hPct)}</dd></div>
      <div><dt className={cardEyebrow}>TVL</dt><dd className="mt-1 font-semibold tabular-nums">{money(pool.tvlUsd)}</dd></div>
      <div><dt className={cardEyebrow}>24h vol</dt><dd className="mt-1 font-semibold tabular-nums">{money(pool.volume24hUsd)}</dd></div>
      <div><dt className={cardEyebrow}>Fee</dt><dd className="mt-1 font-semibold tabular-nums">{pool.feeTierBps === null ? pool.chain === "robinhood" ? "Dynamic" : "—" : `${pool.feeTierBps} bps`}</dd></div>
    </dl>
    <div className="mt-auto flex flex-wrap items-center gap-3 pt-5">
      <OpenButton action={action} label={pool.pairLabel} />
      {raydium && <Link href={buildPlanPath({ poolId: pool.poolAddress, pair: pool.pairLabel })}
        className="inline-flex h-11 items-center rounded-full border border-ink/40 px-4 text-sm font-semibold outline-none transition-colors hover:border-ink focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]">
        Plan this pool
      </Link>}
      {raydium
        ? <a href={raydiumPoolUrl(pool.poolAddress)} target="_blank" rel="noreferrer" title={`Open pool ${pool.poolAddress} on Raydium`}
          className="ml-auto font-data text-[10px] tracking-[0.08em] text-ink/60 underline underline-offset-2 outline-none hover:text-ink focus-visible:text-ink">
          {pool.poolAddress.slice(0, 4)}…{pool.poolAddress.slice(-4)}</a>
        : <span className="ml-auto font-data text-[10px] tracking-[0.08em] text-ink/55" title={pool.poolAddress}>{pool.poolAddress.slice(0, 4)}…{pool.poolAddress.slice(-4)}</span>}
    </div>
  </li>;
}

function Select<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (value: T) => void; options: { value: T; label: string }[];
}) {
  return <label className="flex flex-col gap-1 text-[11px] text-smoke">{label}
    <select value={value} onChange={(event) => onChange(event.target.value as T)}
      className="rounded-xl border border-white/20 bg-white/[0.06] px-3 py-2 text-sm text-cream outline-none focus:border-white/40">
      {options.map((option) => <option key={option.value} value={option.value} className="bg-char">{option.label}</option>)}
    </select>
  </label>;
}

/** "$5k", "$10k", "$50k" for the TVL filter presets. */
const tvlPresetLabel = (usd: number) => usd >= 1_000_000 ? `$${usd / 1_000_000}M` : usd >= 1_000 ? `$${usd / 1_000}k` : `$${usd}`;
type TvlChoice = "any" | "custom" | `${number}`;

/**
 * TVL filter: Any (default) / the presets / a custom minimum in USD. Applied before "Hide duplicate pools", so a small
 * pool never hides the bigger pool of its pair.
 */
function TvlFilter({ onChange }: { onChange: (minTvl: number | null) => void }) {
  const [choice, setChoice] = useState<TvlChoice>("any");
  const [custom, setCustom] = useState("");
  const customValue = (text: string) => {
    const value = Number(text.replace(/[$,\s]/g, ""));
    return text.trim() && Number.isFinite(value) && value >= 0 ? value : null;
  };
  return <div className="flex flex-col gap-1 text-[11px] text-smoke">
    <label className="flex flex-col gap-1">Min TVL
      <select value={choice} data-testid="tvl-filter" onChange={(event) => {
        const next = event.target.value as TvlChoice;
        setChoice(next);
        onChange(next === "any" ? null : next === "custom" ? customValue(custom) : Number(next));
      }} className={cn("rounded-xl border bg-white/[0.06] px-3 py-2 text-sm text-cream outline-none focus:border-white/40",
        choice === "any" ? "border-white/20" : "border-lemon/70")}>
        <option value="any" className="bg-char">Any TVL</option>
        {TVL_FILTER_PRESETS.map((usd) => <option key={usd} value={String(usd)} className="bg-char">{`≥ ${tvlPresetLabel(usd)}`}</option>)}
        <option value="custom" className="bg-char">Custom…</option>
      </select>
    </label>
    {choice === "custom" && <label className="flex items-center gap-2">
      <span className="sr-only">Custom minimum TVL in USD</span>
      <span aria-hidden="true">≥ $</span>
      <input type="number" inputMode="numeric" min={0} step={1000} value={custom} placeholder="e.g. 25000" data-testid="tvl-filter-custom"
        onChange={(event) => { setCustom(event.target.value); onChange(customValue(event.target.value)); }}
        className="w-full rounded-xl border border-lemon/70 bg-white/[0.06] px-3 py-1.5 text-sm text-cream outline-none placeholder:text-smoke/70 focus:border-white/40" />
    </label>}
  </div>;
}

export type OpenRhcRequest = { pool: RhcPoolView };

/**
 * `/app/rwa-pairs` pool list: Solana (Raydium; Orca / Meteora when their flags are on) and Robinhood Chain (Uniswap v4) in one
 * list. Cards or a sortable table, search, chain / protocol / TVL filters, and "Hide duplicate pools" (on by default;
 * see `lib/unified-pools/model.ts` for the rule). Opening a Solana pool connects the Solana wallet and opens the
 * existing Create position modal; opening a Robinhood Chain pool asks the page to open its dialog on the nav's EVM wallet.
 */
export function UnifiedPoolsPanel({ flags, onOpenRhc, deepLinkPool = "", header }: {
  flags: UnifiedPoolFlags;
  onOpenRhc: (request: OpenRhcRequest) => void;
  /** `?openPool=` from the URL: open this pool once it is listed. */
  deepLinkPool?: string;
  header?: ReactNode;
}) {
  const { connected, connect } = useWalletConnection();
  const [loaded, setLoaded] = useState<Loaded>({ rows: [], rhc: [], updated: [] });
  const [errors, setErrors] = useState<Partial<Record<Source, string>>>({});
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<"cards" | "list">("cards");
  const [filters, setFilters] = useState<PoolFilters>(DEFAULT_FILTERS);
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [openPair, setOpenPair] = useState<OpenPositionPair | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    const sources: { source: Source; run: () => Promise<Partial<Loaded>> }[] = [
      { source: "raydium", run: async () => {
        const body = await fetchRwaPairsList<{ pairs: SolanaPoolRow[]; tokenIcons?: TokenIconMap; fetchedAt?: string; freshness?: { stale?: boolean } }>(signal);
        return { rows: body.pairs, icons: body.tokenIcons,
          updated: body.fetchedAt ? [{ chain: "solana" as const, fetchedAt: body.fetchedAt, stale: body.freshness?.stale ?? false }] : [] };
      } },
      ...(flags.orca ? [{ source: "orca" as const, run: async () => ({ rows: (await getJson<{ pairs: SolanaPoolRow[] }>("/api/protocol-pools?protocol=orca-whirlpool", signal)).pairs }) }] : []),
      ...(flags.meteora ? [{ source: "meteora" as const, run: async () => ({ rows: (await getJson<{ pairs: SolanaPoolRow[] }>("/api/protocol-pools?protocol=meteora-dlmm", signal)).pairs }) }] : []),
      ...(flags.rhc ? [{ source: "rhc" as const, run: async () => {
        const body = await getJson<{ pools: RhcPoolSummary[]; fetchedAt?: string; snapshot?: { stale?: boolean } }>("/api/protocol-pools?protocol=uniswap-v4-rhc", signal);
        return { rhc: body.pools,
          updated: body.fetchedAt ? [{ chain: "robinhood" as const, fetchedAt: body.fetchedAt, stale: body.snapshot?.stale ?? false }] : [] };
      } }] : []),
    ];
    const results = await Promise.allSettled(sources.map((entry) => entry.run()));
    if (signal?.aborted) return;
    const next: Loaded = { rows: [], rhc: [], updated: [] };
    const nextErrors: Partial<Record<Source, string>> = {};
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        next.rows.push(...(Array.isArray(result.value.rows) ? result.value.rows : []));
        next.rhc.push(...(Array.isArray(result.value.rhc) ? result.value.rhc : []));
        if (result.value.icons) next.icons = result.value.icons;
        next.updated.push(...(result.value.updated ?? []));
      } else nextErrors[sources[index]!.source] = SOURCE_ERROR[sources[index]!.source];
    });
    setLoaded(next); setErrors(nextErrors); setLoading(false);
  }, [flags.orca, flags.meteora, flags.rhc]);

  useEffect(() => {
    const aborter = new AbortController();
    const timer = window.setTimeout(() => { void load(aborter.signal); }, 0);
    return () => { window.clearTimeout(timer); aborter.abort(); };
  }, [load]);

  // Same cadence as the old RWA pairs list: re-read the saved lists and APR every minute while the tab is visible.
  useEffect(() => {
    const aborter = new AbortController();
    const timer = window.setInterval(() => {
      if (!document.hidden) { setRefreshKey((key) => key + 1); void load(aborter.signal); }
    }, 60_000);
    return () => { window.clearInterval(timer); aborter.abort(); };
  }, [load]);

  const pools = useMemo(() => {
    const seen = new Set<string>();
    const all = [...loaded.rows.map(solanaPool), ...loaded.rhc.map(rhcPool).filter((pool): pool is UnifiedPool => pool !== null)];
    return all.filter((pool) => (seen.has(pool.key) ? false : (seen.add(pool.key), true)));
  }, [loaded]);
  const rowsByKey = useMemo(() => new Map(loaded.rows.map((row) => [`solana:${row.poolAddress}`, row])), [loaded.rows]);
  const rhcByKey = useMemo(() => new Map(loaded.rhc.map((summary) => [`robinhood:${summary.poolId.toLowerCase()}`, summary])), [loaded.rhc]);

  const apr = usePoolsApr7d(pools, refreshKey);
  const apr7d = useCallback((pool: UnifiedPool) => { const state = apr[pool.key]; return state?.status === "ready" ? state.aprPct : null; }, [apr]);
  const selected = useMemo(() => selectPools(pools, { filters, hideDuplicates: !showAll, sort, apr7d }), [pools, filters, showAll, sort, apr7d]);

  /** `connectWallet: false` for deep links: the Create position dialog opens with its own Connect wallet button. */
  const openPool = useCallback((pool: UnifiedPool, connectWallet = true) => {
    if (pool.chain === "robinhood") {
      const summary = rhcByKey.get(pool.key);
      const view = summary ? rhcPoolView(summary) : null;
      if (view) onOpenRhc({ pool: view });
      return;
    }
    const row = rowsByKey.get(pool.key);
    if (!row) return;
    if (connectWallet && !connected) connect();
    setOpenPair({ poolAddress: row.poolAddress, mintA: row.mintA, mintB: row.mintB, symbolA: row.symbolA, symbolB: row.symbolB,
      wrappedSymbol: row.wrappedSymbol, plainSymbol: row.plainSymbol, feeTierBps: row.feeTierBps, token2022A: row.token2022A,
      token2022B: row.token2022B, freezeRisk: row.freezeRisk });
  }, [connected, connect, onOpenRhc, rhcByKey, rowsByKey]);

  const actionFor = useCallback((pool: UnifiedPool): OpenAction => {
    if (pool.protocol === "raydium-clmm" || pool.protocol === "uniswap-v4-rhc") return { kind: "open", onOpen: () => openPool(pool) };
    if (pool.protocol === "meteora-dlmm" && flags.meteoraOpen) return { kind: "link", href: "/app/meteora" };
    return { kind: "none", reason: "Opening is not available yet" };
  }, [flags.meteoraOpen, openPool]);

  // Deep link (`/app/rwa-pairs?openPool=…`, where `/app/rhc` and old `/app?openPool=` links redirect): open that pool once it is listed.
  const [deepLinked, setDeepLinked] = useState(false);
  useEffect(() => {
    if (deepLinked || !deepLinkPool || loading) return;
    const pool = pools.find((item) => item.poolAddress === deepLinkPool || item.poolAddress.toLowerCase() === deepLinkPool.toLowerCase());
    const timer = window.setTimeout(() => {
      setDeepLinked(true);
      if (pool && actionFor(pool).kind === "open") openPool(pool, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [deepLinkPool, deepLinked, loading, pools, actionFor, openPool]);

  const refresh = () => {
    clearPoolRangeAprClientCache();
    setRefreshKey((key) => key + 1);
    setLoading(true);
    void load();
  };
  const onSort = (key: SortKey) => setSort((current) => current.key === key
    ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_CLICK_DIR[key] });
  const setFilter = <K extends keyof PoolFilters>(key: K, value: PoolFilters[K]) => setFilters((current) => ({ ...current, [key]: value }));

  const chains = [...new Set(pools.map((pool) => pool.chain))];
  const protocols = [...new Set(pools.map((pool) => pool.protocol))];
  const errorList = Object.values(errors);
  const updatedText = updatedLabel(loaded.updated);

  return <section id="pools" className="mt-3 scroll-mt-4" aria-labelledby="pools-heading">
    <div className="rounded-[28px] border border-white/12 bg-char p-6 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="pools-heading" className="text-base font-semibold text-cream">Pools</h2>
          <p className="mt-2 max-w-2xl text-xs leading-5 text-smoke">
            Solana and Robinhood Chain pools in one list. The two wallets are separate (top bar): a Solana wallet such as Phantom
            for Solana pools, an EVM wallet such as MetaMask for Robinhood Chain. Opening a pool asks for its chain&apos;s wallet
            if it is not connected yet. {NOT_GUARANTEED}{" "}
            <Link href={DOCS_ROUTES.feeApr} className="text-cream/80 underline underline-offset-2 hover:text-cream">Fee APR</Link>
          </p>
          {updatedText ? <p data-testid="pools-updated" className="mt-2 font-data text-[11px] uppercase tracking-[0.12em] text-smoke">{updatedText}</p> : null}
          {header}
        </div>
        <button type="button" onClick={refresh} disabled={loading}
          className="inline-flex items-center gap-2 rounded-full border border-white/20 px-3 py-2 text-xs font-semibold text-cream/80 hover:border-white/40 disabled:cursor-not-allowed disabled:opacity-40">
          {loading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Refresh
        </button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <label className="flex flex-col gap-1 text-[11px] text-smoke">Search token
          <span className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-smoke" aria-hidden="true" />
            <input type="search" value={filters.query} onChange={(event) => setFilter("query", event.target.value)} placeholder="Name or symbol, e.g. SPCX or Tesla"
              className="w-full rounded-xl border border-white/20 bg-white/[0.06] py-2 pl-9 pr-3 text-sm text-cream outline-none placeholder:text-smoke/70 focus:border-white/40" />
          </span>
        </label>
        <Select label="Chain" value={filters.chain} onChange={(value) => setFilter("chain", value)}
          options={[{ value: "all", label: "All chains" }, ...chains.map((chain) => ({ value: chain, label: CHAIN_LABELS[chain] }))] as { value: PoolChain | "all"; label: string }[]} />
        <Select label="Protocol" value={filters.protocol} onChange={(value) => setFilter("protocol", value)}
          options={[{ value: "all", label: "All protocols" }, ...protocols.map((protocol) => ({ value: protocol, label: PROTOCOL_LABELS[protocol] }))] as { value: UnifiedProtocol | "all"; label: string }[]} />
        <TvlFilter onChange={(minTvl) => setFilter("minTvl", minTvl)} />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="View" className="inline-flex rounded-full border border-white/20 p-0.5">
            {([["cards", "Cards", LayoutGrid], ["list", "List", List]] as const).map(([value, label, Icon]) => (
              <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}
                className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold", view === value ? "bg-cream text-ink" : "text-cream/80 hover:text-cream")}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />{label}
              </button>
            ))}
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-cream/80">
            <input type="checkbox" role="switch" aria-checked={!showAll} checked={!showAll} onChange={(event) => setShowAll(!event.target.checked)} className="h-4 w-4 accent-lemon" />
            Hide duplicate pools
            <InfoTip label="About Hide duplicate pools">
              When one chain has several pools for the same two tokens, only the one with the highest estimated 7-day APR is shown.
              Pools without a 7-day estimate rank below those with one (then by TVL). Pools on different chains are never merged. Pools under the Min TVL filter are left out first, so they never hide a bigger pool.
            </InfoTip>
          </label>
          {!showAll && selected.hiddenDuplicates > 0 && (
            <button type="button" onClick={() => setShowAll(true)} className="text-xs text-smoke underline underline-offset-2 hover:text-cream" data-testid="show-all-pools">
              Show all pools ({selected.hiddenDuplicates} hidden)
            </button>
          )}
        </div>
        {view === "cards" && <Select<SortKey> label="Sort by" value={sort.key} onChange={(key) => setSort({ key, dir: FIRST_CLICK_DIR[key] })}
          options={COLUMNS.map((column) => ({ value: column.key, label: column.label }))} />}
      </div>

      {errorList.length > 0 && <div role="alert" className="mt-4 space-y-1 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">
        {errorList.map((message) => <p key={message}>{message}</p>)}
      </div>}
      {loading && !pools.length && <p role="status" className="mt-6 inline-flex items-center gap-2 text-sm text-smoke"><LoaderCircle className="h-4 w-4 animate-spin" />Loading pools…</p>}
      {!loading && pools.length > 0 && selected.pools.length === 0 && <p className="mt-6 text-sm text-smoke">No pools match these filters.</p>}
      <p className="sr-only" role="status">{selected.pools.length} pools shown</p>
    </div>

    {selected.pools.length > 0 && (view === "cards"
      ? <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="pools-cards">
          {selected.pools.map((pool) => <PoolCard key={pool.key} pool={pool} apr={apr[pool.key]} action={actionFor(pool)} icons={loaded.icons} />)}
        </ul>
      : <PoolTable pools={selected.pools} apr={apr} actionFor={actionFor} sort={sort} onSort={onSort} icons={loaded.icons} />)}

    {openPair && <OpenPositionModal pair={openPair} onClose={() => setOpenPair(null)} />}
  </section>;
}
