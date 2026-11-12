"use client";
import "@/lib/engine-host";
import { notEnoughBalanceMessage } from "@sofinance/engine/balance-message";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUpRight, LoaderCircle } from "lucide-react";
import { assetMetadata, assetSymbol } from "./token-picker";
import { formatAmount } from "@sofinance/engine/amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { PositionAssetRow } from "./position-asset-row";
import { resolveNftAccountLookup } from "@/lib/exit-account-lookup";
import { useTokenMetadata } from "./use-token-metadata";
import { useSelectedController } from "./use-selected-controller";
import { TransactionStatusDialog } from "./transaction-status-dialog";
import { useCompoundController } from "./use-compound-controller";
import { InkFooter, InkHero, InkNav } from "./ink";
import { ConnectWalletPrompt } from "./connect-wallet-prompt";
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
import { capabilitiesFor, firstSupportedTool, parsePositionKey, positionKey, positionKeysEqual, toolUnavailableReason, type ToolId, type UnifiedPosition } from "@/lib/unified-positions/model";
import { CLOSED_LABEL, groupPositions, isClosed, positionOptionLabel, SOLANA_CONNECT_EMPTY_OPTION, type PositionGroup } from "@/lib/unified-positions/rows";
import type { ExternalPositions } from "./unified-positions/external-positions";
import { GroupedPositionSelect } from "./unified-positions/grouped-position-select";
import { RegistryPositionDetails, RegistryPositionHeader, useRegistryPositions } from "./unified-positions/registry-positions";
import { RegistryPositionTool, type ToolBalance } from "./unified-positions/registry-tools";
import { useStoredTokenIcons } from "./use-stored-token-icons";
import { tokenSymbol } from "@/lib/position-label";
import { type OverviewPosition } from "./stocks-overview";
import { Collapsible } from "./collapsible";
import { fetchDexPerformance } from "@/lib/dex/client";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import { shortAddress } from "@/lib/format/address";
import { solscanAccountUrl } from "@/lib/format/explorer";

const short = shortAddress;
const money = (value: string, decimals: number, digits = 6) => formatAmount(value, decimals, digits);
const tokenLabel = (mint: string, kind?: "native" | "token") =>
  kind === "native" ? "SOL" : mint === USDC_MINT ? "USDC" : mint === NATIVE_SOL_MINT ? "WSOL" : short(mint);

export function SelectedApp({ initialView = "compound", initialMint: initialMintProp = "", initialWallet = "", previewPoolId = "", initialPositionKey: initialKeyProp = "", external, onRescan }: {
  initialView?: "compound" | "performance" | "deposit" | "withdraw";
  initialMint?: string;
  initialWallet?: string;
  previewPoolId?: string;
  /** `?position=<key>` (any source). A key of the inline Solana source selects through `initialMint`, as before. */
  initialPositionKey?: string;
  /** Other chains' positions, in All positions under their own chain group (`/app`: Robinhood Chain). */
  external?: ExternalPositions;
  /** Called by "Rescan wallet" alongside the Solana rescan, so the other chains' positions in All positions rescan too. */
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
    onConfirmed: () => { void refreshState(); } });
  // Unclaimed fees come from the compound reader (same accrual formula as the Performance card); its snapshot also carries the
  // liquidity amounts, so rows show liquidity and unclaimed fees from one consistent read when it is available.
  // Duplicates the visibleState filter in use-compound-controller.ts:223 (it already drops another wallet's or position's state):
  // kept as a second guard so a stale fee read of the previous position can never render beside this one.
  const feeState = state && compound.state?.positionMint === state.positionMint ? compound.state : null;
  const assets = feeState ?? state;
  const busy = addBusy || compound.busy || withdrawBusy;
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
  // Registry rows: token icons from the stored icon map (the pairs list's source), fetched only when such a row is listed.
  const storedIcons = useStoredTokenIcons(connected && registry.positions.length > 0);
  const walletBalances: Record<string, ToolBalance> = Object.fromEntries((discovery?.assets ?? []).map((asset) => [asset.mint, { balance: asset.balance, decimals: asset.decimals }]));
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  const [assetRisksOpen, setAssetRisksOpen] = useState(false);
  const [activeView, setActiveView] = useState<ToolId>(initialView);
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
  const nftAccountLookup = resolveNftAccountLookup({ connected, targetMint: performanceMint, discovery, state,
    loadingDiscovery, loadingState, hasError: Boolean(stateError) });
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
  const groups = groupPositions(allPositions, { solana: [positionSource.id, ...registryListed], ...(external ? { [external.chain]: external.sourceIds } : {}) },
    external ? ["solana" as const, external.chain] : []);
  const [otherKey, setOtherKey] = useState(initialPositionKey);
  const solanaEmpty = !connected || (discovery !== null && !loadingDiscovery && positionOptions.length === 0);
  // A picked (or linked) non-inline position; without one, the first of them when the inline scan has none.
  const otherSelected = otherPositions.find((item) => positionKeysEqual(item.key, otherKey) || item.key === otherKey)
    ?? (!otherKey && solanaEmpty && !initialMint ? otherPositions[0] ?? null : null);
  const otherBinding = otherSelected && registry.owns(otherSelected)
    ? { header: (item: UnifiedPosition) => <RegistryPositionHeader position={item} metadata={metadata} icons={storedIcons} showAssets={activeView !== "performance"} />, details: (item: UnifiedPosition) => <RegistryPositionDetails position={item} />,
      // Keyed by the position only: the cross-op lock is per position and must not depend on the open tab (PM review of #289).
      tool: (item: UnifiedPosition, view: ToolId) => <RegistryPositionTool key={item.key} position={item} descriptor={registry.descriptor(item)!}
        capabilities={registry.capabilities(item)!} view={view} balances={walletBalances} symbolOf={(token) => tokenSymbol(token.id, metadata, token.symbol)}
        onConfirmed={() => { setOtherKey(item.key); setRegistryRefresh((value) => value + 1); void refreshDiscovery(); }}
        onPerformance={(key, result) => setPanelResult({ key, ...result })} showStockPerformance={!stockShownInOverview}
        positionPicker={view === "compound" ? compoundPicker : undefined} />,
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
    const first = firstSupportedTool(capabilities);
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
    if (found.source === positionSource.id) { setOtherKey(""); pickPosition(found.nativeId); } else setOtherKey(found.key);
    writeUrl(found.key, activeView);
  };
  const changeView = (view: ToolId) => { setActiveView(view); writeUrl(selectedKey, view); };
  const optionLabel = (item: UnifiedPosition, group: PositionGroup) =>
    positionOptionLabel(item.source === positionSource.id ? positionSource : registry.owns(item) ? registry.optionSource(item, metadata) : external!.source as never, item as never, { showSourceName: group.showSourceName, metadata });
  const anyBusy = busy || Boolean(external?.busy);
  // Compound fees tab: no All positions card. The position to compound is picked from a small dropdown beside the
  // panel title, listing only positions that can compound, and only when there is more than one of them.
  const canCompound = (item: UnifiedPosition) => (item.source === positionSource.id ? capabilitiesFor(positionSource, item)
    : registry.owns(item) ? registry.capabilities(item) : external ? capabilitiesFor(external.source, item) : null)?.compound.supported ?? false;
  const compoundGroups = groups.map((group) => ({ ...group, positions: group.positions.filter(canCompound) })).filter((group) => group.positions.length);
  const compoundPicker = compoundGroups.reduce((count, group) => count + group.positions.length, 0) > 1
    // The wrapper bounds the select to the card on phones (a long pair label would otherwise widen it).
    ? <div className="w-full min-w-0 sm:w-auto sm:max-w-[26rem]"><GroupedPositionSelect id="compound-position" label="Position to compound" value={selectedKey}
      disabled={anyBusy} onChange={pickKey} groups={compoundGroups} optionLabel={optionLabel} emptyOption={() => ""}
      className="w-full rounded-full border border-white/20 bg-white/[0.06] py-1.5 pl-3 text-base sm:text-sm text-cream outline-none focus:border-white/40 disabled:opacity-50" /></div>
    : connected && discovery && !loadingDiscovery && !allPositions.length && !registry.loadingNames.length
      ? <a href={APP_ROUTES.rwaPairs} className="text-xs font-semibold text-cream underline underline-offset-4">Explore pools to open a position</a>
      : null;
  // Hidden only while a Compound panel (which carries the picker) is shown for a connected Solana wallet. Without one the
  // card stays for its connect prompt; an unavailable Compound keeps it to switch positions from.
  const showAllPositions = activeView !== "compound" || !connected || Boolean(unavailableReason);
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
  const overviewPositions: OverviewPosition[] = !connected || !wallet || awaitingDefaultSelection ? [] : [
    ...solanaPositions.filter((item) => !isClosed(item)).map((item): OverviewPosition => ({ key: item.key,
      positionId: item.nativeId, pool: { id: item.poolId, source: positionSource.displayName,
        label: `${poolLabel(item.tokenA.id)} / ${poolLabel(item.tokenB.id)}` }, load: async (signal) => {
      const params = new URLSearchParams({ positionMint: item.nativeId, wallet });
      const response = await fetch(`/api/position-performance?${params}`, { signal, headers: { Accept: "application/json" } });
      const body = await response.json().catch(() => null) as (PositionPerformanceReport & { error?: string }) | null;
      if (!response.ok || !body || body.positionMint !== item.nativeId) throw new Error(body?.error || "Performance could not be loaded.");
      return body;
    }, fromPanel: fromPanel(item.key) })),
    ...registry.positions.filter((item) => !isClosed(item) && registry.capabilities(item)?.performance.supported).map((item): OverviewPosition => ({
      key: item.key, positionId: item.nativeId, pool: { id: item.poolId, source: registry.optionSource(item, metadata).displayName,
        label: `${tokenSymbol(item.tokenA.id, metadata, item.tokenA.symbol)} / ${tokenSymbol(item.tokenB.id, metadata, item.tokenB.symbol)}` },
      load: async (signal) => (await fetchDexPerformance(registry.descriptor(item)!, item.key, { signal })).report ?? null,
      fromPanel: fromPanel(item.key) })),
  ];
  const stockShownInOverview = overviewPositions.length > 0 && panelResult?.key === panelKey
    && Boolean(panelResult.report?.stock) && overviewPositions.some((item) => item.key === panelKey);
  // "Rescan wallet": the Solana scan (unchanged) plus, on /app, the Robinhood Chain scan via the parent's refresh counter.
  const rescan = () => { if (wallet) { void refreshDiscovery(); setRegistryRefresh((value) => value + 1); } onRescan?.(); };
  // Only uncovered positions get lightweight rows. Stock positions remain reachable through their drilldown;
  // non-Performance tools never mount the overview or start history reads just to select a position.
  const renderPositionRows = (coveredKeys: ReadonlySet<string>) => <div className="space-y-4" data-testid="position-fallback-rows">
    {groups.map((group) => {
      const remaining = group.positions.filter((item) => !coveredKeys.has(item.key));
      if (group.positions.length && !remaining.length) return null;
      return <section key={group.chain} aria-label={group.label} data-testid="position-chain-group">
        <h3 className="mb-2 text-xs font-semibold text-smoke">{group.label}</h3>
        {remaining.length ? <ul className="space-y-2">{remaining.map((item) => <li key={item.key}>
          <button type="button" data-testid="position-fallback-select" data-position-key={item.key}
            aria-pressed={selectedKey === item.key} disabled={anyBusy} onClick={() => pickKey(item.key)}
            className={`w-full rounded-xl border px-4 py-3 text-left text-sm transition-colors enabled:hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50 ${selectedKey === item.key ? "border-mint/40 bg-mint/5" : "border-white/10"}`}>
            {optionLabel(item, group)}{selectedKey === item.key && <span className="ml-3 text-xs text-mint">Selected</span>}
          </button>
        </li>)}</ul> : <p className="text-xs text-smoke">{group.chain === external?.chain ? external.emptyOption : connected ? "No positions found" : SOLANA_CONNECT_EMPTY_OPTION}</p>}
      </section>;
    })}
    {!allPositions.length && <p className="text-sm text-smoke">{loadingDiscovery ? "Loading positions…" : connected ? "No identifiable position found" : "Connect wallet to view positions"}</p>}
  </div>;
  return <div className="min-h-screen bg-canvas text-cream">
    <div className="relative mx-auto max-w-[1280px] px-3 pb-32 pt-3 max-sm:pb-[max(8rem,calc(var(--tx-notice-bottom-offset,0px)+2rem))] sm:px-5 sm:pt-5">
      <InkNav wallet={wallet} connected={connected} onConnect={connect} onDisconnect={disconnect} />

      <InkHero stacked className="mt-3 border border-transparent" label="Positions" title="Manage my liquidity positions">Add fees back to original position, or invest new capital.</InkHero>

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
        onCloseWithdraw={() => setActiveView("compound")}
        onWithdrawBusy={onWithdrawBusy}
        onWithdrawConfirmed={() => { void refreshState(); void refreshDiscovery(); }}
        compound={compound}
        onConnect={connect}
        compoundPicker={compoundPicker}
        linkedForeignPosition={Boolean(linkedForeignPosition)}
        initialMint={initialMint}
        performanceMint={performanceMint}
        selectedNftAccount={nftAccountLookup.account}
        nftAccountPending={nftAccountLookup.pending}
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
      {showAllPositions && <section aria-labelledby="all-positions-heading" className="mt-3 rounded-[28px] border border-white/12 bg-char p-5 sm:p-7">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 id="all-positions-heading" className="text-base font-semibold text-cream">All positions</h2>
          <button type="button" disabled={(!wallet && !(external && onRescan)) || anyBusy} onClick={rescan} className="text-xs font-semibold text-cream/80 transition-opacity hover:opacity-70 disabled:opacity-40">Rescan wallet</button>
        </div>
        {activeView === "performance" ? <StocksSection positions={overviewPositions} selectedPositionKey={selectedKey} onSelectPosition={pickKey} selectionDisabled={anyBusy} renderRemainingPositions={renderPositionRows} /> : renderPositionRows(new Set())}
        <div className="mt-5 border-t border-white/10 pt-4" data-testid="selected-position-detail">
        {(otherSelected ?? selectedSolana) && <p className="mb-3 break-all text-xs text-smoke">Selected position · {(otherSelected ?? selectedSolana)!.key}</p>}
        {/* The Solana connect prompt belongs to Solana: with another chain's position selected it lives in the empty Solana group instead. */}
        {!connected && !otherSelected && <div className="mt-3"><ConnectWalletPrompt onConnect={connect} /></div>}
        {connected && discovery && positionOptions.length === 0 && !otherSelected && <a href={APP_ROUTES.rwaPairs} className="mt-3 text-sm font-semibold text-cream underline underline-offset-4">Explore pools to open a position</a>}
        {(otherSelected ?? selectedSolana) && isClosed((otherSelected ?? selectedSolana)!) && <p className="mt-3 w-fit rounded-full border border-white/20 px-2.5 py-1 text-xs font-semibold text-smoke" data-testid="position-closed">{CLOSED_LABEL}: no liquidity left</p>}
        {otherSelected && otherBinding ? otherBinding.header(otherSelected) : <>
        {state && <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <span className={`rounded-full border px-2.5 py-1 ${state.inRange ? "border-white/40 bg-white/[0.07] text-cream/80" : "border-white/20 bg-white/[0.05] text-smoke"}`}>{state.rangeSide === "above" ? "Above range · single-sided" : state.rangeSide === "below" ? "Below range · single-sided" : "Price within range"}</span>

        </div>}
        {/* Performance already shows the position's value and fees below: the per-token rows fold away there. */}
        {assets && <Collapsible open={activeView !== "performance"} testId="position-assets-collapse">
          <div aria-label="Position assets" className="mt-5 divide-y divide-white/10">
          <PositionAssetRow symbol={poolLabel(assets.mintA)} icon={metadata[assets.mintA]?.icon ?? null} decimals={assets.decimalsA}
            liquidityRaw={assets.currentAmounts.a} unclaimedFeesRaw={feeState?.fees.a ?? null} priceUsd={assets.pricing?.priceUsdA ?? null} />
          <PositionAssetRow symbol={poolLabel(assets.mintB)} icon={metadata[assets.mintB]?.icon ?? null} decimals={assets.decimalsB}
            liquidityRaw={assets.currentAmounts.b} unclaimedFeesRaw={feeState?.fees.b ?? null} priceUsd={assets.pricing?.priceUsdB ?? null} />
          </div>
        </Collapsible>}
        </>}
        {registry.loadingNames.length ? <p role="status" className="mt-2 text-xs text-smoke" data-testid="registry-positions-loading">Loading {registry.loadingNames.join(", ")} positions…</p> : null}
        {registry.errors.map((message) => <p key={message} role="alert" className="mt-2 text-xs text-cream/80" data-testid="registry-positions-error">{message}</p>)}
        {external?.status}
        {(connected || otherSelected) && <div className="mt-6 border-t border-white/10 pt-5 text-sm leading-relaxed">
          <button type="button" aria-haspopup="dialog" onClick={() => setAssetRisksOpen(true)}
            className="text-xs font-semibold text-cream/80 transition-opacity hover:opacity-70 disabled:opacity-40">
            Learn more details
          </button>
        </div>}
        </div>
      </section>}
      </PositionToolsSection>
      {connectionError && activeView === "compound" && !otherSelected && <div role="alert" className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{connectionError}</div>}
      {error && !quoteError && activeView === "compound" && !otherSelected && <div role="alert" className="mt-4 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">{error}</div>}
      <InkFooter />
    </div>
    <AssetRisksDialog open={Boolean(connected || otherSelected) && assetRisksOpen} onOpenChange={setAssetRisksOpen}>
      {otherSelected && otherBinding ? otherBinding.details(otherSelected) : state && <><p>Real-time pool price: {Number(state.price).toPrecision(8)} · ticks {state.tickLower}–{state.tickUpper} · slot {state.slot}</p><p>Wallet pool asset balance: {money(state.balances.a, state.decimalsA)} {poolLabel(state.mintA)}  +  {money(state.balances.b, state.decimalsB)} {poolLabel(state.mintB)} · SOL {money(String(state.solLamports), 9)}</p><button type="button" onClick={() => void refreshState()} disabled={busy} className="text-cream/80 underline disabled:opacity-40">Reload on-chain</button><p>Pool: <a className="text-cream/80 underline" href={solscanAccountUrl(state.poolId)} target="_blank" rel="noreferrer">{state.poolId} <ArrowUpRight className="inline h-3 w-3" /></a></p><p>Position NFT: {state.positionMint}</p><p>Pool A mint: {state.mintA}</p><p>Pool B mint: {state.mintB}</p><p>Input mint: {selection?.inputMint}</p></>}<p>Different tokens may have issuer, transfer restrictions, or routing liquidity risks. APR does not represent this position&apos;s realizable returns; no trading fees collected for this range while outside.</p>
      <p><Link href={DOCS_ROUTES.risks} className="text-lemon underline underline-offset-2 hover:text-[#fff27f]">Read the Risks docs</Link> before adding liquidity.</p>
    </AssetRisksDialog>
    <TransactionStatusDialog attempt={visibleAttempt} status={attemptStatus} error={error} open={statusDialogOpen}
      onOpenChange={setStatusDialogOpen}
      onRetry={selectionAligned && !busy && retryAdd ? () => { if (!selectionAligned || busy) return; setStatusDialogOpen(false); retryAdd(); } : undefined} />
    {activeView === "deposit" && !otherSelected && !unavailableReason && <div ref={actionBarRef} data-testid="mobile-action-bar" className="fixed inset-x-0 bottom-0 z-10 border-t border-white/12 bg-canvas/95 p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] backdrop-blur sm:hidden"><button className={buttonClass} disabled={actionDisabled} aria-busy={actionLoading} onClick={primaryAction}>{actionLoading ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <ArrowDown aria-hidden="true" className="h-4 w-4" />}{buttonLabel}</button></div>}
  </div>;
}
