"use client";
import "@/lib/engine-host";
import { notEnoughBalanceMessage } from "@sofinance/engine/balance-message";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, LoaderCircle, RefreshCw } from "lucide-react";
import { assetMetadata, assetSymbol } from "./token-picker";
import { formatAmount } from "@sofinance/engine/amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { resolveNftAccountLookup } from "@/lib/exit-account-lookup";
import { useTokenMetadata } from "./use-token-metadata";
import { useSelectedController } from "./use-selected-controller";
import { TransactionStatusDialog } from "./transaction-status-dialog";
import { useCompoundController } from "./use-compound-controller";
import { InkFooter, InkNav } from "./ink";
import { useNoticeBottomOffset } from "./transactions/notice-offset";
import { AddLiquiditySection } from "./add-liquidity-section";
import { PositionToolsSection } from "./position-tools-section";
import { StocksSection } from "./stocks-section";
import { useInlinePositionSelection } from "./use-inline-position-selection";
import { AssetRisksDialog } from "./asset-risks-dialog";
import { APP_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import { formatSelectedNoRouteMessage, JUPITER_NO_ROUTE_CODE } from "@/lib/selected-no-route";
import { AMOUNT_TOO_SMALL_CODE, formatAmountTooSmallMessage, formatSmallLegMovesPriceMessage, SMALL_LEG_MOVES_PRICE_CODE } from "@/lib/selected-amount-error";
import Link from "next/link";
import { captureGrowthEvent } from "@/lib/analytics/client";
import { GROWTH_EVENTS } from "@/lib/analytics/events";
import { raydiumPositionSource as positionSource } from "@/lib/unified-positions/sources/raydium";
import { capabilitiesFor, DEFAULT_DETAIL_VIEW, firstDetailTool, parsePositionKey, positionKey, positionKeysEqual, toolUnavailableReason, type SourceCapabilities, type ToolId, type UnifiedPosition } from "@/lib/unified-positions/model";
import { CLOSED_LABEL, groupPositions, isClosed } from "@/lib/unified-positions/rows";
import type { ExternalPositions } from "./unified-positions/external-positions";
import { RegistryPositionDetails, RegistryPositionHeader, useRegistryPositions } from "./unified-positions/registry-positions";
import { RegistryPositionTool, RegistryRowCompound, type ToolBalance } from "./unified-positions/registry-tools";
import { RaydiumCompoundFeedback, RaydiumRowCompound } from "./compound-panel";
import { tokenSymbol } from "@/lib/position-label";
import { type OverviewPosition } from "./stocks-overview";
import { fetchDexPerformance } from "@/lib/dex/client";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import { shortAddress } from "@/lib/format/address";
import { solscanAccountUrl } from "@/lib/format/explorer";
import { PortfolioSummary } from "./portfolio/portfolio-summary";
import { PortfolioPositionList, rowActions, type PortfolioRow } from "./portfolio/portfolio-rows";
import { usePositionReports, type LoadedReport } from "./portfolio/use-position-reports";
import { invalidateReports } from "./portfolio/report-cache";
import { portfolioTotals, positionFigures, type FiguresState, type PositionFigures } from "@/lib/portfolio/figures";

const short = shortAddress;
const money = (value: string, decimals: number, digits = 6) => formatAmount(value, decimals, digits);
const tokenLabel = (mint: string, kind?: "native" | "token") =>
  kind === "native" ? "SOL" : mint === USDC_MINT ? "USDC" : mint === NATIVE_SOL_MINT ? "WSOL" : short(mint);

export function SelectedApp({ initialView = DEFAULT_DETAIL_VIEW, initialMint: initialMintProp = "", initialWallet = "", previewPoolId = "", initialPositionKey: initialKeyProp = "", external, onRescan }: {
  initialView?: "compound" | "performance" | "deposit" | "withdraw";
  initialMint?: string;
  initialWallet?: string;
  previewPoolId?: string;
  /** `?position=<key>` (any source). A key of the inline Solana source selects through `initialMint`, as before. */
  initialPositionKey?: string;
  /** Other chains' positions, in All positions under their own chain group (`/app`: Robinhood Chain). */
  external?: ExternalPositions;
  /** Called by "Refresh" alongside the Solana rescan, so the other chains' positions in All positions rescan too. */
  onRescan?: () => void;
} = {}) {
  // The inline (scanned) Solana source keeps its `?mint=` path; every other source's key selects through All positions.
  const linkedKey = parsePositionKey(initialKeyProp);
  const linksInline = linkedKey?.source === positionSource.id;
  const initialMint = linksInline ? linkedKey.nativeId : initialMintProp;
  const initialPositionKey = linksInline ? "" : initialKeyProp;
  const [withdrawBusy,setWithdrawBusy]=useState(false);
  const controller = useSelectedController();
  const { wallet, connected, connect, disconnect, connectionError,
    discovery, selection, state, amount, tolerancePercent, result, attempt, attemptStatus,
    error, reprepare, quoteError, quoteErrorCode, quoteErrorOutputMint, quoteErrorAmount, showQuoteRecalculate,
    busy: addBusy, retryAdd, calculating, now, quote, fresh, status, insufficientInput,
    actionLabel, actionDisabled: addDisabled, primaryAction: addAction, changeAmount, changeTolerance, fillMax,
    choosePosition, chooseAsset, refreshDiscovery, refreshState, retryCalculation,
    loadingDiscovery, loadingState, stateError } = controller;
  // My positions from DEXes served through the registry (PR5): every Solana-wallet DEX except the inline source above.
  const [registryRefresh, setRegistryRefresh] = useState(0);
  // Portfolio numbers: forget the cached reports (all, or the given positions) and read them again.
  const [reportsRefresh, setReportsRefresh] = useState(0);
  const refreshReports = (keys?: readonly string[]) => { invalidateReports(keys); setReportsRefresh((value) => value + 1); };
  const registry = useRegistryPositions({ owner: connected ? wallet || null : null, signer: "solana-wallet", exclude: [positionSource.id], refresh: registryRefresh });
  const totalCostPercent = quote && typeof quote.roundtripCostInput === "string" && BigInt(quote.requested) > 0n
    ? (Number(quote.roundtripCostInput) / Number(quote.requested) * 100).toFixed(2)
    : null;
  // Read-only picks survive missing Add inputs, but never survive a wallet commit or removal.
  // Reconcile the controller before exposing any operation target, including the render before effects run.
  const { ownedPick, inlineMint, selectionAligned, setInlinePick } = useInlinePositionSelection({
    wallet, connected, discovery, selection, initialMint,
  });
  const pickPosition = (positionMint: string) => { setPickedPosition(true); setInlinePick({ wallet: wallet || "", mint: positionMint }); choosePosition(positionMint); };
  const compound = useCompoundController({ wallet: wallet || undefined, positionMint: selectionAligned ? selection?.positionMint : undefined,
    // Selection alignment gates positionMint above, not wallet-wide leftover recovery.
    externalBlocked: addBusy || withdrawBusy,
    // A confirmed compound changed this position's fees and value: read its Portfolio numbers again.
    onConfirmed: () => {
      void refreshState();
      refreshReports(selectionAligned && selection?.positionMint ? [positionKey(positionSource.id, selection.positionMint)] : undefined);
    } });
  const busy = addBusy || compound.busy || withdrawBusy;
  // A Raydium row's Compound clicked while another position was selected: run it once that position's fees are read.
  // Resolved while rendering (run, or its checks say no; a failed read or any other pick drops it); one click = one run.
  const [compoundIntent, setCompoundIntent] = useState<string | null>(null);
  const [intentSawLoading, setIntentSawLoading] = useState(false);
  const [compoundRun, setCompoundRun] = useState<{ id: number; mint: string } | null>(null);
  const compoundRunDone = useRef(0);
  if (compoundIntent) {
    if (!wallet || (selectionAligned && selection?.positionMint !== compoundIntent)) setCompoundIntent(null);
    else if (compound.positionMint === compoundIntent) {
      if (compound.loading) { if (!intentSawLoading) setIntentSawLoading(true); }
      else if (compound.state) {
        setCompoundIntent(null);
        if (compound.canCompound) setCompoundRun({ id: (compoundRun?.id ?? 0) + 1, mint: compoundIntent });
      } else if (intentSawLoading) setCompoundIntent(null);
    }
  }
  useEffect(() => {
    if (!compoundRun || compoundRunDone.current === compoundRun.id) return;
    compoundRunDone.current = compoundRun.id;
    // Same entry and checks as a click on the selected row (the controller re-checks everything before the wallet).
    if (compound.positionMint === compoundRun.mint && compound.canCompound) compound.compound();
  }, [compoundRun, compound]);
  useLayoutEffect(() => {
    if (!busy && ownedPick && selection && selection.positionMint !== ownedPick.mint) choosePosition(ownedPick.mint);
  }, [busy, ownedPick, selection, choosePosition]);
  const actionDisabled = connected && (!selectionAligned || addDisabled || compound.busy || withdrawBusy);
  const actionLoading = connected && (busy || calculating);
  const buttonLabel = !connected ? "Connect wallet" : compound.busy ? "Another operation in progress…" :
    calculating ? "Estimating liquidity…" : actionLabel;
  const buttonClass = `inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-4 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] ${actionLoading ? "cursor-wait disabled:opacity-100" : "disabled:cursor-not-allowed disabled:opacity-40"}`;
  const primaryAction = () => { if (!connected) { connect(); return; } if (selectionAligned && !busy) addAction(); };
  const metadataMints = [
    ...(discovery?.assets.map((asset) => asset.mint) || []),
    ...(discovery?.positions.flatMap((item) => [item.mintA, item.mintB]) || []),
    ...(state ? [state.mintA, state.mintB] : []),
    ...registry.positions.flatMap((item) => [item.tokenA.id, item.tokenB.id]),
  ];
  const metadata = useTokenMetadata(metadataMints);
  const walletBalances: Record<string, ToolBalance> = Object.fromEntries((discovery?.assets ?? []).map((asset) => [asset.mint, { balance: asset.balance, decimals: asset.decimals }]));
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [assetRisksOpen, setAssetRisksOpen] = useState(false);
  // No Compound tab (LJ 11/14): an old `view=compound` link opens the default detail tab; Compound is the row's button.
  const [activeView, setActiveView] = useState<ToolId>(initialView === "compound" ? DEFAULT_DETAIL_VIEW : initialView);
  // The Performance panel's last read (by position key), handed to the all-stocks overview so it is not read twice.
  const [panelResult, setPanelResult] = useState<{ key: string; report: PositionPerformanceReport | null; error: boolean } | null>(null);
  // Step 1 of a 100% withdrawal closes the position, and its confirmation's balances refresh then reads no
  // position (`state` becomes null). Unmounting the Withdraw panel then aborted its run before step 2 (convert)
  // was prepared. So while a withdrawal is running or partly done (busy, or a checkpoint/Resume is pending),
  // the panel stays pinned to its position, but only while that position is still the one selected.
  const liveWithdraw = selectionAligned && state && wallet && state.positionMint === selection?.positionMint ? { wallet, positionMint: state.positionMint, mintA: state.mintA, mintB: state.mintB } : null;
  const liveWithdrawRef = useRef(liveWithdraw);
  useLayoutEffect(() => { liveWithdrawRef.current = liveWithdraw; });
  const [withdrawTarget, setWithdrawTarget] = useState<typeof liveWithdraw>(null);
  // Stable: the panel re-reports busy whenever its own state changes; the pin only moves to a live position.
  const onWithdrawBusy = useCallback((next: boolean) => {
    setWithdrawBusy(next);
    if (next && liveWithdrawRef.current) setWithdrawTarget(liveWithdrawRef.current);
  }, []);
  const pinnedWithdraw = withdrawBusy && withdrawTarget && withdrawTarget.wallet === wallet
    && withdrawTarget.positionMint === selection?.positionMint ? withdrawTarget : null;
  const shownWithdraw = selectionAligned ? liveWithdraw ?? pinnedWithdraw : null;
  // Toasts sit above the phone-only bottom action bar instead of covering its button.
  // The same measured height (incl. the iPhone home-bar inset) pads the page bottom on phones, so the bar never hides content.
  const actionBarRef = useRef<HTMLDivElement | null>(null);
  useNoticeBottomOffset(actionBarRef, activeView === "deposit");
  // Performance is a tab inside /app (the URL does not change), so $pageview cannot see it.
  useEffect(() => {
    if (activeView === "performance") captureGrowthEvent(GROWTH_EVENTS.performanceView);
  }, [activeView]);
  // A deep link (?mint=) wins over the wallet's default selection until the user picks a position themselves. It is applied
  // once per wallet (the controller resets the selection whenever the wallet changes).
  const linkedPositionWallet = useRef("");
  const [pickedPosition, setPickedPosition] = useState(false);
  useEffect(() => {
    if (!wallet || linkedPositionWallet.current === wallet || !initialMint || !discovery) return;
    if (discovery.positions.some((position) => position.positionMint === initialMint)) {
      linkedPositionWallet.current = wallet;
      choosePosition(initialMint);
    }
  }, [initialMint, discovery, wallet, choosePosition]);
  const linkActive = Boolean(initialMint) && !pickedPosition;
  const performanceMint = linkActive ? initialMint : inlineMint || initialMint;
  // The exit estimate lives in the Withdraw tool: it reads the selected (held) position, not the Performance deep link.
  const exitTargetMint = !withdrawBusy && liveWithdraw ? liveWithdraw.positionMint : "";
  const nftAccountLookup = resolveNftAccountLookup({ connected, targetMint: exitTargetMint, discovery, state,
    loadingDiscovery, loadingState, hasError: Boolean(stateError) });
  const exitEstimate = exitTargetMint && liveWithdraw ? { positionMint: exitTargetMint, nftAccount: nftAccountLookup.account,
    pending: nftAccountLookup.pending, poolMints: [liveWithdraw.mintA, liveWithdraw.mintB] as const } : null;
  const linkedForeignPosition = linkActive && connected && discovery !== null && !loadingDiscovery
    && !discovery.positions.some((position) => position.positionMint === initialMint);
  const visibleAttempt = attempt?.wallet === wallet ? attempt : null;
  useEffect(() => {
    const timer = window.setTimeout(() => setStatusDialogOpen(false), 0);
    return () => window.clearTimeout(timer);
  }, [wallet]);
  const selectedAsset = discovery?.assets.find((asset) => asset.kind === selection?.inputKind && asset.mint === selection?.inputMint);
  const inputLabel = selectedAsset ? assetSymbol(selectedAsset, assetMetadata(selectedAsset, metadata)) : "Input asset";
  const addStatus = compound.busy ? "A compound or recovery operation is in progress."
    : insufficientInput && selectedAsset ? notEnoughBalanceMessage({ ...insufficientInput, symbol: inputLabel }) : status;
  // Positions are read through the Raydium position source (unified-positions PR-A); same list and order as the scan.
  const solanaPositions = positionSource.fromDiscovery(discovery);
  const positionOptions = solanaPositions.map((position) => position.native);
  // One entry for every chain (unified positions). Tools and header come from the selected position's source.
  // "Other" positions are everything not read by the inline scan: registry DEXes on Solana and the other chain's binding.
  const externalPositions = external?.positions ?? [];
  const otherPositions: UnifiedPosition[] = [...(connected ? registry.positions : []), ...externalPositions];
  const allPositions: UnifiedPosition[] = [...(connected ? solanaPositions : []), ...otherPositions];
  // A registry DEX only names the sources ("Raydium CLMM · …") once it returned a position: with none, the Solana
  // options read exactly as on a Raydium-only page.
  const registryListed = registry.sourceIds.filter((id) => registry.positions.some((item) => item.source === id));
  const groups = groupPositions(allPositions, { solana: [positionSource.id, ...registryListed], ...(external ? { [external.chain]: external.sourceIds } : {}) });
  const [otherKey, setOtherKey] = useState(initialPositionKey);
  const solanaEmpty = !connected || (discovery !== null && !loadingDiscovery && positionOptions.length === 0);
  // A picked (or linked) non-inline position; without one, the first of them when the inline scan has none.
  const otherSelected = otherPositions.find((item) => positionKeysEqual(item.key, otherKey) || item.key === otherKey)
    ?? (!otherKey && solanaEmpty && !initialMint ? otherPositions[0] ?? null : null);
  const otherBinding = otherSelected && registry.owns(otherSelected)
    ? { header: (item: UnifiedPosition) => <RegistryPositionHeader position={item} />, details: (item: UnifiedPosition) => <RegistryPositionDetails position={item} />,
      // Keyed by the position only: the cross-op lock is per position and must not depend on the open tab (PM review of #289).
      tool: (item: UnifiedPosition, view: ToolId) => <RegistryPositionTool key={item.key} position={item} descriptor={registry.descriptor(item)!}
        capabilities={registry.capabilities(item)!} view={view} balances={walletBalances} symbolOf={(token) => tokenSymbol(token.id, metadata, token.symbol)}
        onConfirmed={() => { setOtherKey(item.key); setRegistryRefresh((value) => value + 1); void refreshDiscovery(); refreshReports([item.key]); }}
        onPerformance={(key, result) => setPanelResult({ key, ...result })} showStockPerformance={!stockShownInOverview} />,
      capabilities: registry.capabilities(otherSelected)! }
    : otherSelected && external ? { header: external.header, details: external.details, tool: external.tool, capabilities: capabilitiesFor(external.source, otherSelected) }
      : null;
  const selectedSolana = solanaPositions.find((item) => item.nativeId === inlineMint) ?? null;
  const capabilities = otherSelected && otherBinding ? otherBinding.capabilities : capabilitiesFor(positionSource, selectedSolana);
  const unavailableReason = toolUnavailableReason(capabilities, activeView);
  const selectedKey = otherSelected?.key ?? (inlineMint ? positionKey(positionSource.id, inlineMint) : "");
  // Landing on a position whose current tool is unavailable opens its first available tool (a greyed tab clicked later stays).
  const [viewCheckedFor, setViewCheckedFor] = useState(selectedKey);
  if (viewCheckedFor !== selectedKey) {
    setViewCheckedFor(selectedKey);
    const first = firstDetailTool(capabilities);
    if (unavailableReason && first) setActiveView(first);
  }
  const writeUrl = (key: string, view: ToolId) => {
    if (!key || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("mint"); url.searchParams.delete("positionMint");
    url.searchParams.set("position", key); url.searchParams.set("view", view);
    window.history.replaceState(window.history.state, "", url);
  };
  const pickKey = (key: string) => {
    const found = allPositions.find((item) => item.key === key || positionKeysEqual(item.key, key));
    if (!found) return;
    setCompoundIntent(null);
    if (found.source === positionSource.id) { setOtherKey(""); pickPosition(found.nativeId); } else setOtherKey(found.key);
    writeUrl(found.key, activeView);
  };
  const changeView = (view: ToolId) => { setActiveView(view); writeUrl(selectedKey, view); };
  const anyBusy = busy || Boolean(external?.busy);
  const assetOptions = discovery?.assets || [];
  const poolLabel = (mint: string) => {
    const asset = assetOptions.find((item) => item.mint === mint);
    return asset ? assetSymbol(asset, assetMetadata(asset, metadata)) : metadata[mint]?.symbol || tokenLabel(mint);
  };
  const noRouteOutput = quoteErrorOutputMint || state?.mintA || "";
  const displayError = quoteErrorCode === JUPITER_NO_ROUTE_CODE && noRouteOutput
    ? formatSelectedNoRouteMessage(inputLabel, poolLabel(noRouteOutput))
    : quoteErrorCode === AMOUNT_TOO_SMALL_CODE && quoteErrorAmount && quoteErrorOutputMint && state && error === quoteError
      ? formatAmountTooSmallMessage({ input: inputLabel, minority: poolLabel(quoteErrorOutputMint),
        majority: quoteErrorAmount.majorityMint ? poolLabel(quoteErrorAmount.majorityMint) : undefined,
        minimum: money(quoteErrorAmount.minimumInput, state.inputDecimals, state.inputDecimals) })
      : quoteErrorCode === SMALL_LEG_MOVES_PRICE_CODE && quoteErrorOutputMint && state && error === quoteError
        ? formatSmallLegMovesPriceMessage({ minority: poolLabel(quoteErrorOutputMint),
          majority: poolLabel(quoteErrorOutputMint === state.mintA ? state.mintB : state.mintA) })
        : error;
  // Performance tab, all-stocks overview: every open Solana position whose source reads performance (the other chain has none).
  // The position the Performance panel below reads is taken from that panel instead of being read again.
  const panelKey = unavailableReason ? "" : otherSelected ? (otherBinding ? otherSelected.key : "")
    : performanceMint ? positionKey(positionSource.id, performanceMint) : "";
  const fromPanel = (key: string): OverviewPosition["fromPanel"] => key !== panelKey ? undefined
    : panelResult?.key === key ? { report: panelResult.report, error: panelResult.error } : "loading";
  // A registry scan can finish before the inline wallet scan. Until default selection is known,
  // keep its rows selectable but let the eventual selected panel own the first report read.
  // Explicit picks/deep links can read immediately; a failed wallet scan must not stall the overview.
  const awaitingDefaultSelection = !discovery && !stateError && !otherSelected && !performanceMint;
  // Every open Solana position whose source reads Performance: the Portfolio numbers and the Performance overview read
  // the same reports (shared cache, one read per position).
  const performanceSources: Omit<OverviewPosition, "fromPanel">[] = !connected || !wallet ? [] : [
    ...solanaPositions.filter((item) => !isClosed(item)).map((item): OverviewPosition => ({ key: item.key,
      positionId: item.nativeId, pool: { id: item.poolId, source: positionSource.displayName,
        label: `${poolLabel(item.tokenA.id)} / ${poolLabel(item.tokenB.id)}` }, load: async (signal) => {
      const params = new URLSearchParams({ positionMint: item.nativeId, wallet });
      const response = await fetch(`/api/position-performance?${params}`, { signal, headers: { Accept: "application/json" } });
      const body = await response.json().catch(() => null) as (PositionPerformanceReport & { error?: string }) | null;
      if (!response.ok || !body || body.positionMint !== item.nativeId) throw new Error(body?.error || "Performance could not be loaded.");
      return body;
    } })),
    ...registry.positions.filter((item) => !isClosed(item) && registry.capabilities(item)?.performance.supported).map((item): OverviewPosition => ({
      key: item.key, positionId: item.nativeId, pool: { id: item.poolId, source: registry.optionSource(item, metadata).displayName,
        label: `${tokenSymbol(item.tokenA.id, metadata, item.tokenA.symbol)} / ${tokenSymbol(item.tokenB.id, metadata, item.tokenB.symbol)}` },
      load: async (signal) => (await fetchDexPerformance(registry.descriptor(item)!, item.key, { signal })).report ?? null })),
  ];
  const overviewPositions: OverviewPosition[] = awaitingDefaultSelection ? []
    : performanceSources.map((item) => ({ ...item, fromPanel: fromPanel(item.key) }));
  // Portfolio numbers: on Performance the selected position's own panel reads its report, so the totals take that result.
  const panelOwnsReport = activeView === "performance" && Boolean(panelKey);
  // On Performance an unresolved default selection waits, so its first report read belongs to the panel (no double read).
  const portfolioReports = usePositionReports(activeView === "performance" && awaitingDefaultSelection ? []
    : panelOwnsReport ? performanceSources.filter((item) => item.key !== panelKey) : performanceSources, { refresh: reportsRefresh });
  const reportFor = (key: string): LoadedReport | "loading" | undefined => panelOwnsReport && key === panelKey
    ? panelResult?.key === key ? panelResult : "loading" : portfolioReports[key];
  const reportedKeys = new Set(performanceSources.map((item) => item.key));
  const capabilitiesOf = (item: UnifiedPosition): SourceCapabilities => item.source === positionSource.id ? capabilitiesFor(positionSource, item)
    : registry.owns(item) ? registry.capabilities(item)! : capabilitiesFor(external!.source, item);
  const figuresOf = (item: UnifiedPosition): PositionFigures | null => {
    if (!reportedKeys.has(item.key)) return external && item.chain === external.chain ? external.figures?.(item) ?? null : null;
    const loaded = reportFor(item.key);
    return loaded && loaded !== "loading" && !loaded.error ? positionFigures(loaded.report) : null;
  };
  const portfolio = portfolioTotals(allPositions.filter((item) => !isClosed(item) && reportedKeys.has(item.key)).map((item): FiguresState => {
    const loaded = reportFor(item.key);
    return !loaded || loaded === "loading" ? { status: "loading" } : loaded.error ? { status: "failed" } : { status: "ready", figures: positionFigures(loaded.report) };
  }), allPositions.filter((item) => !isClosed(item) && !reportedKeys.has(item.key)).map((item) => figuresOf(item)?.valueUsd ?? null));
  const stockShownInOverview = overviewPositions.length > 0 && panelResult?.key === panelKey
    && Boolean(panelResult.report?.stock) && overviewPositions.some((item) => item.key === panelKey);
  // One "Refresh" (was "Rescan wallet" + "Reload fees"): the Solana scan, the selected position's on-chain state and fees, the
  // registry DEXes and, on /app, the Robinhood Chain scan via the parent's refresh counter.
  const refreshAll = () => {
    if (wallet) {
      void refreshDiscovery(); setRegistryRefresh((value) => value + 1); refreshReports();
      if (selectionAligned && selection?.positionMint) { void refreshState(); void compound.refreshState(); }
    }
    onRescan?.();
  };
  const selectedItem = otherSelected ?? selectedSolana;
  // A selected position (the inline scan's selection counts before its row is read); its detail carries the tool tabs.
  const hasSelection = Boolean(selectedItem) || Boolean(connected && selection?.positionMint);
  // Tools sit under the selected position; a Performance deep link (`?mint=`, `?pool=`) also shows without one.
  const showTools = hasSelection || (activeView === "performance" && Boolean(performanceMint || previewPoolId));
  const loadingPositions = connected && (loadingDiscovery || !discovery) && !stateError;
  const showEmpty = !allPositions.length && !loadingPositions && !registry.loadingNames.length;
  // Portfolio rows (every tool's list). On Performance, stock positions are covered by the overview above them.
  const sourceName = (item: UnifiedPosition) => item.source === positionSource.id ? positionSource.displayName
    : registry.owns(item) ? registry.optionSource(item, metadata).displayName : external?.source.displayName ?? "";
  const pairOf = (item: UnifiedPosition) => `${tokenSymbol(item.tokenA.id, metadata, item.tokenA.symbol || poolLabel(item.tokenA.id))} / ${tokenSymbol(item.tokenB.id, metadata, item.tokenB.symbol || poolLabel(item.tokenB.id))}`;
  // The row's Compound is the only Compound entry (LJ 11/14). Raydium: one controller for the selected position, so a row
  // that is not selected is selected first and compounds once its fees are read (`compoundIntent`, one click = at most one
  // run). Meteora (registry): the row runs its DEX's flow itself. Both keep their checks, wallet prompt and refetch.
  const compoundRow = (item: UnifiedPosition) => {
    if (anyBusy || compoundIntent) return;
    const mint = item.nativeId;
    if (compound.positionMint === mint && compound.state && !compound.loading) {
      if (compound.canCompound) compound.compound();
      return;
    }
    setIntentSawLoading(false);
    setCompoundIntent(mint);
    setOtherKey(""); pickPosition(mint); writeUrl(item.key, activeView);
  };
  const rowCompound = (item: UnifiedPosition): PortfolioRow["compound"] => {
    if (isClosed(item)) return undefined;
    if (item.source === positionSource.id) return function raydiumRowCompound(slot) { return <RaydiumRowCompound controller={compound} positionMint={item.nativeId}
      pending={compoundIntent === item.nativeId} onCompound={() => compoundRow(item)} slot={slot} tokenLabel={poolLabel} />; };
    const descriptor = registry.owns(item) ? registry.descriptor(item) : null;
    if (!descriptor || !registry.capabilities(item)?.compound.supported) return undefined;
    return function registryRowCompound(slot) { return <RegistryRowCompound position={item} descriptor={descriptor} slot={slot}
      symbolOf={(token) => tokenSymbol(token.id, metadata, token.symbol)}
      onConfirmed={() => { setRegistryRefresh((value) => value + 1); void refreshDiscovery(); refreshReports([item.key]); }} />; };
  };
  const portfolioRows = new Map<string, PortfolioRow>(groups.flatMap((group) => group.positions.map((item): [string, PortfolioRow] => {
    const figures = figuresOf(item);
    // Position number tells apart two positions in the same pair (an NFT mint shortened, an EVM token id as-is).
    const id = `#${String(item.nativeId).length > 12 ? short(String(item.nativeId)) : String(item.nativeId)}`;
    const pair = item.tokenA.id || item.tokenB.id ? pairOf(item) : "";
    const title = figures?.stock ?? (pair || `Position ${id}`);
    return [item.key, { item, figures, title,
      subtitle: [title !== pair ? pair : null, group.showSourceName ? sourceName(item) : null, title.endsWith(id) ? null : id].filter(Boolean).join(" · "),
      actions: rowActions(capabilitiesOf(item), isClosed(item)), compound: rowCompound(item) }];
  })));
  const openTool = (key: string, view: ToolId) => {
    const found = allPositions.find((item) => item.key === key || positionKeysEqual(item.key, key));
    if (!found) return;
    setCompoundIntent(null);
    setActiveView(view);
    if (found.source === positionSource.id) { setOtherKey(""); pickPosition(found.nativeId); } else setOtherKey(found.key);
    writeUrl(found.key, view);
  };
  const renderPositionRows = (coveredKeys: ReadonlySet<string>) => <PortfolioPositionList
    groups={groups.map((group) => ({ ...group, positions: group.positions.filter((item) => !coveredKeys.has(item.key)) }))}
    rows={portfolioRows} selectedKey={selectedKey} disabled={anyBusy} onSelect={pickKey} onAction={openTool} />;
  return <div className="min-h-screen bg-canvas text-cream">
    <div className="relative mx-auto max-w-[1280px] px-3 pb-32 pt-3 max-sm:pb-[max(8rem,calc(var(--tx-notice-bottom-offset,0px)+2rem))] sm:px-5 sm:pt-5">
      <InkNav wallet={wallet} connected={connected} onConnect={connect} onDisconnect={disconnect} />

      <div className="relative">
      <RaydiumCompoundFeedback controller={compound} />
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 px-1">
        <h1 className="text-xl font-semibold text-cream sm:text-2xl">Portfolio</h1>
        <button type="button" disabled={(!wallet && !(external && onRescan)) || anyBusy} onClick={refreshAll}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-3 py-1.5 text-xs font-semibold text-cream/80 transition-colors hover:border-white/40 disabled:opacity-40">
          <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${loadingDiscovery || compound.loading ? "animate-spin motion-reduce:animate-none" : ""}`} />Refresh
        </button>
      </div>

      {allPositions.length > 0 && <PortfolioSummary totals={portfolio} />}

      <PositionToolsSection
        activeView={activeView}
        onChangeView={changeView}
        capabilities={capabilities}
        otherSelected={otherSelected}
        state={state}
        wallet={wallet || ""}
        busy={busy}
        unavailableReason={unavailableReason}
        otherBinding={otherBinding}
        shownWithdraw={shownWithdraw}
        poolLabel={poolLabel}
        onCloseWithdraw={() => setActiveView(DEFAULT_DETAIL_VIEW)}
        onWithdrawBusy={onWithdrawBusy}
        onWithdrawConfirmed={() => { void refreshState(); void refreshDiscovery(); }}
        compound={compound}
        linkedForeignPosition={Boolean(linkedForeignPosition)}
        initialMint={initialMint}
        performanceMint={performanceMint}
        exitEstimate={exitEstimate}
        showTools={showTools}
        initialWallet={initialWallet}
        previewPoolId={previewPoolId}
        stockShownInOverview={stockShownInOverview}
        onPerformanceResult={(mint, result) => setPanelResult({ key: positionKey(positionSource.id, mint), ...result })}
        addLiquidity={<AddLiquiditySection
          hidden={activeView !== "deposit"}
          assetOptions={assetOptions}
          selectedAsset={selectedAsset}
          metadata={metadata}
          busy={busy}
          onSelectAsset={chooseAsset}
          inputPriceUsd={state?.pricing?.priceUsdInput}
          amount={amount}
          onChangeAmount={changeAmount}
          onFillMax={fillMax}
          inputLabel={inputLabel}
          state={state}
          tolerancePercent={tolerancePercent}
          onChangeTolerance={changeTolerance}
          actionDisabled={actionDisabled}
          actionLoading={actionLoading}
          buttonClass={buttonClass}
          buttonLabel={buttonLabel}
          onPrimaryAction={primaryAction}
          addStatus={addStatus}
          connected={connected}
          connectionError={connectionError || ""}
          displayError={displayError}
          showQuoteRecalculate={showQuoteRecalculate}
          onRetryCalculation={retryCalculation}
          reprepare={Boolean(reprepare)}
          calculating={calculating}
          quote={quote}
          fresh={fresh}
          now={now}
          result={result}
          totalCostPercent={totalCostPercent}
          poolLabel={poolLabel}
          attempt={attempt}
          visibleAttempt={visibleAttempt}
          attemptStatus={attemptStatus || ""}
          onOpenStatus={() => setStatusDialogOpen(true)}
        />}
      >
      {(tabs) => <section aria-labelledby="all-positions-heading" className="mt-3 rounded-[28px] border border-white/12 bg-char p-5 sm:p-7">
        <h2 id="all-positions-heading" className="mb-5 text-base font-semibold text-cream">All positions</h2>
        {showEmpty ? <PositionsEmptyState connected={connected} onConnect={connect} />
          : !allPositions.length ? <p role="status" className="text-sm text-smoke">Loading positions…</p>
          : activeView === "performance" ? <StocksSection positions={overviewPositions} selectedPositionKey={selectedKey} onSelectPosition={pickKey} selectionDisabled={anyBusy} renderRemainingPositions={renderPositionRows} /> : renderPositionRows(new Set())}
        {registry.loadingNames.length ? <p role="status" className="mt-2 text-xs text-smoke" data-testid="registry-positions-loading">Loading {registry.loadingNames.join(", ")} positions…</p> : null}
        {registry.errors.map((message) => <p key={message} role="alert" className="mt-2 text-xs text-cream/80" data-testid="registry-positions-error">{message}</p>)}
        {external?.status}
        {hasSelection && <div className="mt-5 border-t border-white/10 pt-4" data-testid="selected-position-detail" data-selected-key={selectedKey}>
        {selectedItem && isClosed(selectedItem) && <p className="mt-3 w-fit rounded-full border border-white/20 px-2.5 py-1 text-xs font-semibold text-smoke" data-testid="position-closed">{CLOSED_LABEL}: no liquidity left</p>}
        {otherSelected && otherBinding ? otherBinding.header(otherSelected) : <>
        {/* No range badge or per-token Liquidity / Unclaimed fees rows here: the position's row above already shows its
            shares, value and fees (LJ 11/14). */}
        </>}
        <button type="button" aria-haspopup="dialog" onClick={() => setAssetRisksOpen(true)}
          className="mt-4 text-xs font-semibold text-cream/80 transition-opacity hover:opacity-70 disabled:opacity-40">
          Learn more details
        </button>
        {/* Harvest account recovery has its own page (LJ 11/14): linked only from a Raydium position's details. */}
        {selectedSolana && !otherSelected && <Link href={`${APP_ROUTES.portfolioRecovery}?position=${encodeURIComponent(selectedSolana.key)}`}
          data-testid="harvest-recovery-link" className="ml-4 mt-4 inline-block text-xs font-semibold text-cream/80 underline underline-offset-2 hover:opacity-70">
          Recover leftover compound balances</Link>}
        {tabs}
        </div>}
      </section>}
      </PositionToolsSection>
      </div>
      <InkFooter />
    </div>
    <AssetRisksDialog open={hasSelection && assetRisksOpen} onOpenChange={setAssetRisksOpen}>
      {otherSelected && otherBinding ? otherBinding.details(otherSelected) : state && <p>Pool: <a className="text-cream/80 underline" href={solscanAccountUrl(state.poolId)} target="_blank" rel="noreferrer">{state.poolId} <ArrowUpRight className="inline h-3 w-3" /></a></p>}<p>Different tokens may have issuer, transfer restrictions, or routing liquidity risks. APR does not represent this position&apos;s realizable returns; no trading fees collected for this range while outside.</p>
      <p><Link href={DOCS_ROUTES.risks} className="text-lemon underline underline-offset-2 hover:text-[#fff27f]">Read the Risks docs</Link> before adding liquidity.</p>
    </AssetRisksDialog>
    <TransactionStatusDialog attempt={visibleAttempt} status={attemptStatus} error={error} open={statusDialogOpen}
      onOpenChange={setStatusDialogOpen}
      onRetry={selectionAligned && !busy && retryAdd ? () => { if (!selectionAligned || busy) return; setStatusDialogOpen(false); retryAdd(); } : undefined} />
    {showTools && activeView === "deposit" && !otherSelected && !unavailableReason && <div ref={actionBarRef} data-testid="mobile-action-bar" className="fixed inset-x-0 bottom-0 z-10 border-t border-white/12 bg-canvas/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] backdrop-blur sm:hidden"><button className={buttonClass} disabled={actionDisabled} aria-busy={actionLoading} onClick={primaryAction}>{actionLoading ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ArrowDown aria-hidden="true" className="h-4 w-4" />}{buttonLabel}</button></div>}
  </div>;
}

/** The one empty state of All positions: one sentence and the way to Pools (plus Connect while no wallet is connected). */
function PositionsEmptyState({ connected, onConnect }: { connected: boolean; onConnect: () => void }) {
  return <div data-testid="positions-empty-state" className="rounded-2xl border border-white/12 bg-white/[0.03] p-4 sm:p-5">
    <p className="text-sm leading-6 text-cream/80">{connected ? "No positions in this wallet yet." : "Connect your wallet to see your positions."}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {!connected && <button type="button" onClick={onConnect} className="rounded-full bg-lemon px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f]">Connect wallet</button>}
      <a href={APP_ROUTES.rwaPairs} className="rounded-full border border-white/25 px-4 py-2 text-sm font-semibold text-cream transition-colors hover:border-white/50 hover:bg-white/[0.04]">Go to Pools</a>
    </div>
  </div>;
}
