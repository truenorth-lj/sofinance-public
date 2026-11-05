"use client";
import "@/lib/engine-host";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownUp, ChevronDown, LayoutGrid, List, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { CARD_POOL_AVG_APR_7D_HELP, CARD_RANGE_APR_7D_HELP, POOL_AVG_APR_7D_LABEL } from "@/lib/apr-labels/copy";
import { cn } from "@/lib/cn";
import { dexDescriptors, fetchOpenRanges, type OpenRanges } from "@/lib/dex/client";
import { SUPPORTED } from "@/lib/unified-positions/model";
import { pairLabelSymbols, planShareSymbol } from "@/lib/lp-plan-shares";
import { volumeDivergenceNote } from "@/lib/apr-labels/volume-divergence";
import { HIGHEST_RANGE_COLUMN_LABEL, HIGHEST_RANGE_HELP } from "@/lib/range-apr/copy";
import { unavailableReasonText } from "@/lib/range-apr/format";
import { pairIssuerLabel } from "@/lib/rwa-pair-names";
import type { TokenIconMap } from "@/lib/token-icons/map";
import { fetchRwaPairsList } from "@/lib/rwa-pairs-list";
import type { SnapshotSourceTime } from "@/lib/snapshot-updated";
import {
  CHAIN_LABELS, DEFAULT_FILTERS, DEFAULT_SORT, FIRST_CLICK_DIR, isLowTvl, PROTOCOL_LABELS, selectPools, TVL_FILTER_PRESETS, unsupportedTokenReason,
  type PoolChain, type PoolFilters, type SortKey, type UnifiedPool, type UnifiedProtocol,
} from "@/lib/unified-pools/model";
import { rhcPool, rhcPoolView, solanaPool, type RhcPoolSummary, type SolanaPoolRow } from "@/lib/unified-pools/rows";
import { InfoTip } from "../info-tip";
import { PairTokenIcons } from "../pair-token-icons";
import { OpenPositionModal } from "../open-position-modal";
import { clearPoolRangeAprClientCache, loadPoolRangeApr, type RangeAprProtocol } from "../range-apr/pool-range-apr-client";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";
import { isDexTxRouteEnabled } from "@/lib/protocol-flags";
import { RegistryOpenModal } from "./registry-open-modal";
import { ShareCalcDialog } from "./share-calc-dialog";
import type { RhcPoolView } from "../rhc-univ4-open-panel";
import type { OpenPositionPair } from "../use-open-position-controller";
import { useWalletConnection } from "../wallet-connection";
import { usePoolsApr7d, type Apr7dState } from "./use-pools-apr7d";
import { APR7D_SHORT, Apr7dValue, rangeApr7dLabel, ChainBadge, chip, COLUMNS, iconPair, LowTvlTag, money, OpenButton, PoolTable, type OpenAction } from "./pool-list";
import { dataDaysLabel, MIN_DATA_DAYS } from "@/lib/min-data-days";
import { rankGroupLookup } from "@/lib/unified-pools/apr7d";

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
/** `rwaList`: pool keys from `/api/rwa-pairs` (its Meteora rows are feed `meteora-dlmm-rwa-v1`, with a saved APR snapshot). */
type Loaded = { rows: SolanaPoolRow[]; rhc: RhcPoolSummary[]; icons?: TokenIconMap; updated: SnapshotSourceTime[]; rwaList?: string[] };

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

const raydiumPoolUrl = (poolId: string) => `https://raydium.io/clmm/create-position/?pool_id=${poolId}`;
const cardEyebrow = "font-data text-[10px] uppercase tracking-[0.12em] text-ink/60";

/**
 * One pool as a cream card (the `/app/rwa-pairs` card fields, now for both chains): token icons and issuer names, the
 * estimated highest range APR (7-day) with the range it comes from ("Highest range", the same range the Create position
 * modal calls Best), when the data was updated, confidence and volume notes in the tooltip, then TVL, volume, fee and
 * fee tier (no 24h APR: the 7-day estimate is the only APR shown). "Plan this pool" follows the DEX's `plan` capability (greyed with its reason when unsupported;
 * Raydium, not in the DEX registry yet, keeps its link); Raydium pools also link the pool on Raydium.
 */
/**
 * Card pair name: it may break after the "/" and each half is cut with "…" if it alone is too wide, so a long pair
 * never runs under the APR pill on a 375 px card (the full name is the title). The narrowest cards (phones, and the
 * three-column grid below 2xl) use a smaller name and icons so names like "GOOGLx/" fit whole.
 */
function cardPairName(label: string) {
  const slash = label.indexOf("/");
  const parts = slash < 0 ? [label] : [label.slice(0, slash + 1), label.slice(slash + 1)];
  return parts.map((part, index) => <span key={index} className="inline-block max-w-full truncate align-bottom">{part}</span>);
}

function PoolCard({ pool, apr, action, icons, onCalculate }: {
  pool: UnifiedPool; apr: Apr7dState | undefined; action: OpenAction; icons: TokenIconMap | undefined;
  /** Opens the share calculator over the list (only offered where the DEX's `plan` capability is supported). */
  onCalculate: () => void;
}) {
  const ready = apr?.status === "ready" ? apr : null;
  const volumeNote = ready ? volumeDivergenceNote(pool.volume24hUsd, ready.avgDailyVolumeUsd) : null;
  const withVolumeNote = (text: string) => (volumeNote ? `${text} ${volumeNote}` : text);
  const freshness = apr && apr.status !== "loading" ? apr.freshness : undefined;
  const raydium = pool.protocol === "raydium-clmm";
  // Registered DEXes say through their `plan` capability; Raydium (not in the DEX registry yet) keeps its link.
  const plan = dexDescriptors.descriptorFor(pool.protocol)?.capabilities.plan ?? (raydium ? SUPPORTED : null);
  // Stock pools count shares; the stablecoin pool has no stock, so its button just says Calculate.
  const calcLabel = planShareSymbol(pairLabelSymbols(pool.pairLabel)) ? "Calculate shares" : "Calculate";
  return <li className="flex min-w-0 flex-col rounded-[28px] bg-cream p-6 text-ink" data-pool={pool.key}>
    <div className="flex flex-wrap items-center gap-1.5"><ChainBadge chain={pool.chain} /><span className={cn(chip, "border border-ink/25")}>{PROTOCOL_LABELS[pool.protocol]}</span>
      {isLowTvl(pool) && apr?.status !== "new" && <LowTvlTag tone="light" />}</div>
    <div className="mt-4 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3 max-sm:gap-2 xl:max-2xl:gap-2">
        <PairTokenIcons pair={iconPair(pool)} icons={icons} chain={pool.chain} iconClassName="h-10 w-10 max-sm:h-8 max-sm:w-8 xl:max-2xl:h-8 xl:max-2xl:w-8" />
        <div className="min-w-0">
          <h3 className="text-xl font-medium max-sm:text-lg xl:max-2xl:text-lg leading-tight tracking-[-0.02em]" title={pool.pairLabel} data-testid="pool-card-name">{cardPairName(pool.pairLabel)}</h3>
          <p className="truncate text-xs text-ink/65" title={`${pool.nameA} / ${pool.nameB}`}>{pairIssuerLabel(pool.nameA, pool.nameB)}</p>
        </div>
      </div>
      {/* Capped on phones so a long range label ("Standard-range APR · 7d") wraps instead of squeezing the pair name. */}
      <div className="shrink-0 text-right max-sm:max-w-[8.5rem]">
        <Apr7dValue state={apr} />
        <p className={cn("mt-1.5 flex items-center justify-end gap-1", cardEyebrow)}>
          <span data-testid="apr7d-label">{ready ? ready.capped ? POOL_AVG_APR_7D_LABEL : rangeApr7dLabel(ready.rangeLabel) : apr?.status === "new" ? dataDaysLabel(apr.days) : APR7D_SHORT}</span>
          {ready && <InfoTip label={ready.capped ? "About Pool avg APR" : "About Est. highest range APR"} tone="light">
            {withVolumeNote(ready.capped ? CARD_POOL_AVG_APR_7D_HELP : CARD_RANGE_APR_7D_HELP)}{ready.lowConfidence ? " Low confidence for this pool: thin or patchy recent trading." : ""}
          </InfoTip>}
          {apr?.status === "missing" && apr.degraded && <InfoTip label="About Est. highest range APR" tone="light">{unavailableReasonText("degraded-data")}.</InfoTip>}
        </p>
      </div>
    </div>
    {apr?.status === "missing" && <p className="mt-2 text-xs text-ink/60">{apr.reason}</p>}
    {apr?.status === "new" && <p className="mt-2 text-xs text-ink/60" data-testid="apr7d-new-note">
      Too new for an APR: it shows once the pool has {MIN_DATA_DAYS} days of data.</p>}
    {freshness && <p className="mt-2 text-xs text-ink/60" data-testid="apr-freshness">
      Updated {new Date(freshness.snapshotAt).toLocaleString()}{freshness.delayed && " · Data delayed"}
    </p>}
    {pool.chain === "solana" && !ready?.capped && <div className="mt-4">
      <p className={cn("flex items-center gap-1", cardEyebrow)}>
        {HIGHEST_RANGE_COLUMN_LABEL}
        {ready && <InfoTip label="About Highest range" placement="above" tone="light">{HIGHEST_RANGE_HELP}</InfoTip>}
      </p>
      <span data-testid="highest-range" className={cn("mt-1.5 inline-block max-w-full truncate rounded-full px-3 py-1 align-top text-sm font-medium", ready ? "bg-lilac" : "bg-ink/10")}>
        {ready ? ready.rangeLabel : apr?.status === "missing" || apr?.status === "new" ? "—" : "…"}
      </span>
    </div>}
    <dl className="mt-5 grid grid-cols-3 gap-x-4 gap-y-4 border-t border-ink/20 pt-4">
      <div><dt className={cardEyebrow}>TVL</dt><dd className="mt-1 font-semibold tabular-nums">{money(pool.tvlUsd)}</dd></div>
      <div><dt className={cardEyebrow}>24h vol</dt><dd className="mt-1 font-semibold tabular-nums">{money(pool.volume24hUsd)}</dd></div>
      <div><dt className={cardEyebrow}>Fee</dt><dd className="mt-1 font-semibold tabular-nums">{pool.feeTierBps === null ? pool.chain === "robinhood" ? "Dynamic" : "—" : `${pool.feeTierBps} bps`}</dd></div>
    </dl>
    <div className="mt-auto flex flex-wrap items-center gap-3 pt-5">
      <OpenButton action={action} label={pool.pairLabel} />
      {/* `border-beam` (globals.css): a quiet streak of light circling the border; still for reduced motion. */}
      {plan?.supported && <button type="button" onClick={onCalculate} aria-haspopup="dialog" aria-label={`${calcLabel} for ${pool.pairLabel}`}
        className="border-beam inline-flex h-11 items-center rounded-full border border-ink/25 px-4 text-sm font-semibold outline-none transition-colors hover:border-ink/60 focus-visible:shadow-[0_0_0_3px_var(--color-lilac)]">
        {calcLabel}
      </button>}
      {plan && !plan.supported && <span aria-disabled="true" title={plan.reason} data-testid="plan-unavailable"
        className="inline-flex h-11 cursor-not-allowed items-center rounded-full border border-ink/15 px-4 text-sm font-semibold text-ink/40">
        {calcLabel}<span className="sr-only">: {plan.reason}</span>
      </span>}
      {raydium
        ? <a href={raydiumPoolUrl(pool.poolAddress)} target="_blank" rel="noreferrer" title={`Open pool ${pool.poolAddress} on Raydium`}
          className="ml-auto font-data text-[10px] tracking-[0.08em] text-ink/60 underline underline-offset-2 outline-none hover:text-ink focus-visible:text-ink">
          {pool.poolAddress.slice(0, 4)}…{pool.poolAddress.slice(-4)}</a>
        : <span className="ml-auto font-data text-[10px] tracking-[0.08em] text-ink/55" title={pool.poolAddress}>{pool.poolAddress.slice(0, 4)}…{pool.poolAddress.slice(-4)}</span>}
    </div>
  </li>;
}

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
          rwaList: (Array.isArray(body.pairs) ? body.pairs : []).map((row) => `solana:${row.poolAddress}`),
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
        if (result.value.rwaList) next.rwaList = result.value.rwaList;
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

  const rwaListKeys = useMemo(() => new Set(loaded.rwaList ?? []), [loaded.rwaList]);
  const apr = usePoolsApr7d(pools, refreshKey, rwaListKeys);
  const apr7d = useCallback((pool: UnifiedPool) => { const state = apr[pool.key]; return state?.status === "ready" ? state.aprPct : null; }, [apr]);
  // By APR (either direction): normal pools, then Low TVL, then new pools (no APR yet), then pools not supported yet.
  const group = useMemo(() => rankGroupLookup(apr), [apr]);
  const selected = useMemo(() => selectPools(pools, { filters, hideDuplicates: !showAll, sort, apr7d, group }), [pools, filters, showAll, sort, apr7d, group]);

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

  const [registryOpen, setRegistryOpen] = useState<UnifiedPool | null>(null);
  const [calcPool, setCalcPool] = useState<UnifiedPool | null>(null);
  const closeCalc = useCallback(() => setCalcPool(null), []);
  const actionFor = useCallback((pool: UnifiedPool): OpenAction => {
    const unsupported = unsupportedTokenReason(pool);
    if (unsupported) return { kind: "unsupported", reason: unsupported };
    // Registered DEXes say through their `open` capability and open in the registry dialog (PR10); the shared DEX route
    // is off on some deployments (DEX_TX_ROUTE_ENABLED), and then they offer no Open button at all.
    const open = dexDescriptors.descriptorFor(pool.protocol)?.capabilities.open;
    if (open) {
      if (!open.supported || !isDexTxRouteEnabled()) return { kind: "none", reason: open.supported ? "Opening is not available yet" : open.reason };
      return { kind: "open", onOpen: () => { if (!connected) connect(); setRegistryOpen(pool); } };
    }
    if (pool.protocol === "raydium-clmm" || pool.protocol === "uniswap-v4-rhc") return { kind: "open", onOpen: () => openPool(pool) };
    return { kind: "none", reason: "Opening is not available yet" };
  }, [openPool, connected, connect]);

  // Deep link (`/app/rwa-pairs?openPool=…`, where `/app/rhc` and old `/app?openPool=` links redirect): open that pool once it is listed.
  const [deepLinked, setDeepLinked] = useState(false);
  useEffect(() => {
    if (deepLinked || !deepLinkPool || loading) return;
    const pool = pools.find((item) => item.poolAddress === deepLinkPool || item.poolAddress.toLowerCase() === deepLinkPool.toLowerCase());
    const timer = window.setTimeout(() => {
      setDeepLinked(true);
      if (!pool || actionFor(pool).kind !== "open") return;
      // No auto-connect for a deep link: each dialog shows its own Connect wallet button.
      if (dexDescriptors.descriptorFor(pool.protocol)) setRegistryOpen(pool);
      else openPool(pool, false);
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
