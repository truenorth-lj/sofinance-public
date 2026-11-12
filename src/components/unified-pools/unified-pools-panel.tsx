"use client";
import "@/lib/engine-host";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownUp, ChevronDown, LayoutGrid, List, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { dexDescriptors, fetchOpenRanges, type OpenRanges } from "@/lib/dex/client";
import {
  CHAIN_LABELS, DEFAULT_FILTERS, DEFAULT_SORT, FIRST_CLICK_DIR, PROTOCOL_LABELS, selectPools, TVL_FILTER_PRESETS,
  type PoolChain, type PoolFilters, type SortKey, type UnifiedPool, type UnifiedProtocol,
} from "@/lib/unified-pools/model";
import { rhcPool, rhcPoolView, solanaPool, type RhcPoolSummary, type SolanaPoolRow } from "@/lib/unified-pools/rows";
import { OpenPositionModal } from "../open-position-modal";
import { clearPoolRangeAprClientCache, loadPoolRangeApr, type RangeAprProtocol } from "../range-apr/pool-range-apr-client";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";
import { RegistryOpenModal } from "./registry-open-modal";
import { ShareCalcDialog } from "./share-calc-dialog";
import type { RhcPoolView } from "../rhc-univ4-open-panel";
import type { OpenPositionPair } from "../use-open-position-controller";
import { useWalletConnection } from "../wallet-connection";
import { usePoolsApr7d } from "./use-pools-apr7d";
import { COLUMNS, PoolTable, type OpenAction } from "./pool-list";
import { rankGroupLookup } from "@/lib/unified-pools/apr7d";
import { PoolCard } from "./pool-card";
import { usePoolSources, type UnifiedPoolFlags } from "./use-pool-sources";
import { resolveOpenDispatch } from "./open-dispatch";

export type { UnifiedPoolFlags };

/** Filter-bar pills (11/4 redesign): a rounded dropdown; lemon border once it narrows the list. */
const pillBase = "h-10 rounded-full border bg-white/[0.06] text-base font-semibold sm:text-[13px] text-cream outline-none transition-colors focus-visible:border-white/60";
const pillIdle = "border-white/12 hover:border-white/30";
const pillOn = "border-lemon/70";

function PillSelect<T extends string>({ label, value, onChange, options, active = false, icon, testId }: {
  label: string; value: T; onChange: (value: T) => void; options: { value: T; label: string }[];
  active?: boolean; icon?: ReactNode; testId?: string;
}) {
  return <label className="relative inline-flex">
    <span className="sr-only">{label}</span>
    {icon && <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-cream/70" aria-hidden="true">{icon}</span>}
    <select value={value} data-testid={testId} onChange={(event) => onChange(event.target.value as T)}
      className={cn(pillBase, "appearance-none pr-10 [field-sizing:content]", icon ? "pl-10" : "pl-5", active ? pillOn : pillIdle)}>
      {options.map((option) => <option key={option.value} value={option.value} className="bg-char">{option.label}</option>)}
    </select>
    <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-cream/70" aria-hidden="true" />
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
  return <div className="flex items-center gap-2">
    <PillSelect<TvlChoice> label="Min TVL" value={choice} testId="tvl-filter" active={choice !== "any"} onChange={(next) => {
      setChoice(next);
      onChange(next === "any" ? null : next === "custom" ? customValue(custom) : Number(next));
    }} options={[
      { value: "any", label: "TVL" },
      ...TVL_FILTER_PRESETS.map((usd) => ({ value: `${usd}` as TvlChoice, label: `TVL ≥ ${tvlPresetLabel(usd)}` })),
      { value: "custom", label: "Custom TVL…" },
    ]} />
    {choice === "custom" && <label className="relative inline-flex">
      <span className="sr-only">Custom minimum TVL in USD</span>
      <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[13px] text-smoke" aria-hidden="true">≥ $</span>
      <input type="number" inputMode="numeric" min={0} step={1000} value={custom} placeholder="25000" data-testid="tvl-filter-custom"
        onChange={(event) => { setCustom(event.target.value); onChange(customValue(event.target.value)); }}
        className={cn(pillBase, pillOn, "w-32 pl-10 pr-4 text-base placeholder:text-smoke/70 sm:text-[13px]")} />
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
  const { loaded, errors, loading, refreshKey, refresh: reloadSources } = usePoolSources(flags);
  const [view, setView] = useState<"cards" | "list">("cards");
  const [filters, setFilters] = useState<PoolFilters>(DEFAULT_FILTERS);
  const [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState(DEFAULT_SORT);
  const [openPair, setOpenPair] = useState<OpenPositionPair | null>(null);

  const pools = useMemo(() => {
    const seen = new Set<string>();
    const all = [...loaded.rows.map((row) => solanaPool(row as SolanaPoolRow)), ...loaded.rhc.map((summary) => rhcPool(summary as RhcPoolSummary)).filter((pool): pool is UnifiedPool => pool !== null)];
    return all.filter((pool) => (seen.has(pool.key) ? false : (seen.add(pool.key), true)));
  }, [loaded]);
  const rowsByKey = useMemo(() => new Map(loaded.rows.map((row) => [`solana:${row.poolAddress}`, row as SolanaPoolRow])), [loaded.rows]);
  const rhcByKey = useMemo(() => new Map(loaded.rhc.map((summary) => [`robinhood:${summary.poolId.toLowerCase()}`, summary as RhcPoolSummary])), [loaded.rhc]);

  const rwaListKeys = useMemo(() => new Set(loaded.rwaList ?? []), [loaded.rwaList]);
  const apr = usePoolsApr7d(pools, refreshKey, rwaListKeys);
  const apr7d = useCallback((pool: UnifiedPool) => { const state = apr[pool.key]; return state?.status === "ready" ? state.aprPct : null; }, [apr]);
  // By APR (either direction): normal pools, then Low TVL, then new pools (no APR yet), then pools not supported yet.
  const group = useMemo(() => rankGroupLookup(apr), [apr]);
  const selected = useMemo(() => selectPools(pools, { filters, hideDuplicates: !showAll, sort, apr7d, group }), [pools, filters, showAll, sort, apr7d, group]);

  /** `connectWallet: false` for deep links: the Create position dialog opens with its own Connect wallet button. */
  const openPool = useCallback((pool: UnifiedPool, connectWallet = true) => {
    // E-dispatch: `openUi`, not `chainMeta.opensRhcDialog` / descriptor presence.
    if (resolveOpenDispatch(pool).button.handler === "rhc-dialog") {
      const summary = rhcByKey.get(pool.key);
      const view = summary ? rhcPoolView(summary as RhcPoolSummary) : null;
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

  const [registryOpen, setRegistryOpen] = useState<UnifiedPool | null>(null);
  const [calcPool, setCalcPool] = useState<UnifiedPool | null>(null);
  const closeCalc = useCallback(() => setCalcPool(null), []);
  const actionFor = useCallback((pool: UnifiedPool): OpenAction => {
    const { button } = resolveOpenDispatch(pool);
    if (button.handler === "unsupported") return { kind: "unsupported", reason: button.reason! };
    if (button.handler === "none") return { kind: "none", reason: button.reason! };
    if (button.handler === "registry") return { kind: "open", onOpen: () => { if (!connected) connect(); setRegistryOpen(pool); } };
    return { kind: "open", onOpen: () => openPool(pool) };
  }, [openPool, connected, connect]);

  // Deep link (`/app/rwa-pairs?openPool=…`, where `/app/rhc` and old `/app?openPool=` links redirect): open that pool once it is listed.
  const [deepLinked, setDeepLinked] = useState(false);
  useEffect(() => {
    if (deepLinked || !deepLinkPool || loading) return;
    const pool = pools.find((item) => item.poolAddress === deepLinkPool || item.poolAddress.toLowerCase() === deepLinkPool.toLowerCase());
    const timer = window.setTimeout(() => {
      setDeepLinked(true);
      if (!pool) return;
      const { deepLink } = resolveOpenDispatch(pool);
      // No auto-connect for a deep link: each dialog shows its own Connect wallet button.
      if (deepLink.handler === "registry") setRegistryOpen(pool);
      else if (deepLink.handler === "native-modal" || deepLink.handler === "rhc-dialog") openPool(pool, false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [deepLinkPool, deepLinked, loading, pools, openPool]);

  const refresh = () => {
    clearPoolRangeAprClientCache();
    reloadSources();
  };
  const onSort = (key: SortKey) => setSort((current) => current.key === key
    ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_CLICK_DIR[key] });
  const setFilter = <K extends keyof PoolFilters>(key: K, value: PoolFilters[K]) => setFilters((current) => ({ ...current, [key]: value }));

  const chains = [...new Set(pools.map((pool) => pool.chain))];
  const protocols = [...new Set(pools.map((pool) => pool.protocol))];
  const errorList = Object.values(errors);

  return <section id="pools" className="mt-3 scroll-mt-4" aria-labelledby="pools-heading">
    <div className="rounded-[28px] border border-white/12 bg-char p-4 sm:p-5">
      <h2 id="pools-heading" className="sr-only">Pools</h2>
      {header}
      {/* 11/4 redesign: one row of pill filters (left) with sort, view and refresh (right), then a full-width search. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <PillSelect label="Chain" value={filters.chain} active={filters.chain !== "all"} onChange={(value) => setFilter("chain", value)}
            options={[{ value: "all", label: "Chain" }, ...chains.map((chain) => ({ value: chain, label: CHAIN_LABELS[chain] }))] as { value: PoolChain | "all"; label: string }[]} />
          <PillSelect label="Protocol" value={filters.protocol} active={filters.protocol !== "all"} onChange={(value) => setFilter("protocol", value)}
            options={[{ value: "all", label: "Protocol" }, ...protocols.map((protocol) => ({ value: protocol, label: PROTOCOL_LABELS[protocol] }))] as { value: UnifiedProtocol | "all"; label: string }[]} />
          <TvlFilter onChange={(minTvl) => setFilter("minTvl", minTvl)} />
          {(showAll || selected.hiddenDuplicates > 0) && (
            <button type="button" aria-pressed={showAll} onClick={() => setShowAll((value) => !value)} data-testid="show-all-pools"
              title="When one protocol on one chain has several pools for the same two tokens, only the one with the highest estimated 7-day APR is shown."
              className={cn(pillBase, "px-5", showAll ? "border-cream bg-cream text-ink" : pillIdle)}>
              {showAll ? "Showing duplicates" : `Show duplicates (${selected.hiddenDuplicates})`}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <PillSelect<SortKey> label="Sort by" value={sort.key} icon={<ArrowDownUp className="h-4 w-4" />}
            onChange={(key) => setSort({ key, dir: FIRST_CLICK_DIR[key] })}
            options={COLUMNS.map((column) => ({ value: column.key, label: column.label }))} />
          <div role="group" aria-label="View" className="inline-flex h-10 items-center rounded-full border border-white/12 bg-white/[0.06] p-0.5">
            {([["cards", "Cards", LayoutGrid], ["list", "List", List]] as const).map(([value, label, Icon]) => (
              <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)} title={`${label} view`}
                className={cn("flex h-9 w-9 items-center justify-center rounded-full outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--color-lemon)]",
                  view === value ? "bg-lilac text-ink" : "text-cream/70 hover:text-cream")}>
                <Icon className="h-4 w-4" aria-hidden="true" /><span className="sr-only">{label}</span>
              </button>
            ))}
          </div>
          <button type="button" onClick={refresh} disabled={loading} aria-label="Refresh" title="Refresh"
            className={cn(pillBase, pillIdle, "flex w-10 items-center justify-center disabled:cursor-not-allowed disabled:opacity-40")}>
            {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <label className="relative mt-3 block">
        <span className="sr-only">Search token</span>
        <Search className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-smoke" aria-hidden="true" />
        <input type="search" value={filters.query} onChange={(event) => setFilter("query", event.target.value)} placeholder="Search tokens, e.g. SPCX or Tesla"
          className="h-12 w-full rounded-full border border-white/12 bg-white/[0.03] pl-12 pr-5 text-base text-cream outline-none placeholder:text-smoke/70 focus:border-white/40 sm:text-sm" />
      </label>

      {errorList.length > 0 && <div role="alert" className="mt-4 space-y-1 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">
        {errorList.map((message) => <p key={message}>{message}</p>)}
      </div>}
      {loading && !pools.length && <p role="status" className="mt-6 inline-flex items-center gap-2 text-sm text-smoke"><LoaderCircle className="h-4 w-4 animate-spin" />Loading pools…</p>}
      {!loading && pools.length > 0 && selected.pools.length === 0 && <p className="mt-6 text-sm text-smoke">No pools match these filters.</p>}
      <p className="sr-only" role="status">{selected.pools.length} pools shown</p>
    </div>

    {selected.pools.length > 0 && (view === "cards"
      ? <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="pools-cards">
          {selected.pools.map((pool) => <PoolCard key={pool.key} pool={pool} apr={apr[pool.key]} action={actionFor(pool)} icons={loaded.icons}
            onCalculate={() => setCalcPool(pool)} />)}
        </ul>
      : <PoolTable pools={selected.pools} apr={apr} actionFor={actionFor} sort={sort} onSort={onSort} icons={loaded.icons} />)}

    {calcPool && <ShareCalcDialog key={calcPool.key} pool={calcPool} open={actionFor(calcPool)} onClose={closeCalc} />}
    {openPair && <OpenPositionModal pair={openPair} onClose={() => setOpenPair(null)} />}
    {registryOpen && <RegistryOpenDialog key={registryOpen.key} pool={registryOpen} rwaList={rwaListKeys.has(registryOpen.key)} onClose={() => setRegistryOpen(null)} />}
  </section>;
}

/** The registry open dialog with its pool's preset ranges (the same range APR payload the cards read). */
function RegistryOpenDialog({ pool, rwaList, onClose }: { pool: UnifiedPool; rwaList: boolean; onClose: () => void }) {
  const descriptor = dexDescriptors.descriptorFor(pool.protocol);
  const [ranges, setRanges] = useState<OpenRanges | Error | null>(null);
  const [apr, setApr] = useState<PoolRangeAprPayload | Error | null>(null);
  const dexId = descriptor?.id ?? "";
  useEffect(() => {
    if (!dexId) return;
    let live = true;
    const fail = (fallback: string) => (error: unknown) => (error instanceof Error ? error : new Error(fallback));
    // Ranges come from the server's own calculation (on-chain only); the APR feed is optional and may be down.
    fetchOpenRanges(dexId, pool.poolAddress).then((value) => { if (live) setRanges(value); },
      (error: unknown) => { if (live) setRanges(fail("The server could not work out this pool's ranges.")(error)); });
    const protocol = pool.protocol as RangeAprProtocol;
    (rwaList ? loadPoolRangeApr(pool.poolAddress, protocol, { rwaList: true }) : loadPoolRangeApr(pool.poolAddress, protocol)).then(
      (payload) => { if (live) setApr(payload); },
      (error: unknown) => { if (live) setApr(fail("APR data is unavailable right now.")(error)); },
    );
    return () => { live = false; };
  }, [dexId, pool.poolAddress, pool.protocol, rwaList]);
  if (!descriptor) return null;
  return <RegistryOpenModal pool={pool} descriptor={descriptor} ranges={ranges} apr={apr} onClose={onClose} />;
}
