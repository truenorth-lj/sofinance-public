"use client";
import "@/lib/engine-host";
import { notEnoughBalanceMessage } from "@sofinance/engine/balance-message";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { assetMetadata, assetSymbol } from "./token-picker";
import { formatAmount } from "@sofinance/engine/amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { resolveNftAccountLookup } from "@/lib/exit-account-lookup";
import { useTokenMetadata } from "./use-token-metadata";
import { useSelectedController } from "./use-selected-controller";
import { useWalletConnection } from "./wallet-connection";
import { TransactionStatusDialog } from "./transaction-status-dialog";
import { useCompoundController } from "./use-compound-controller";
import { InkFooter, InkNav } from "./ink";
import { AddLiquiditySection } from "./add-liquidity-section";
import { PositionPerformancePanel } from "./position-performance-panel";
import { PositionExitEstimate } from "./position-exit-estimate";
import { WithdrawPanel } from "./withdraw-panel";
import { UnavailableTool } from "./unified-positions/unavailable-tool";
import { ActionDialog } from "./portfolio/action-dialog";
import { ActivityList } from "./portfolio/activity-list";
import { recordActivity } from "@/lib/portfolio/session-activity";
import { usePositionOpLock } from "./unified-positions/position-op-lock";
import { useInlinePositionSelection } from "./use-inline-position-selection";
import { APP_ROUTES, DOCS_ROUTES } from "@/lib/public-urls";
import Link from "next/link";
import { formatSelectedNoRouteMessage, JUPITER_NO_ROUTE_CODE } from "@/lib/selected-no-route";
import { AMOUNT_TOO_SMALL_CODE, formatAmountTooSmallMessage, formatSmallLegMovesPriceMessage, SMALL_LEG_MOVES_PRICE_CODE } from "@/lib/selected-amount-error";
import { captureGrowthEvent } from "@/lib/analytics/client";
import { GROWTH_EVENTS } from "@/lib/analytics/events";
import { raydiumPositionSource as positionSource } from "@/lib/unified-positions/sources/raydium";
import type { PortfolioView } from "@/lib/unified-positions/url";
import { capabilitiesFor, parsePositionKey, positionKey, positionKeysEqual, toolUnavailableReason, type SourceCapabilities, type ToolId, type UnifiedPosition } from "@/lib/unified-positions/model";
import { CLOSED_LABEL, groupPositions, isClosed } from "@/lib/unified-positions/rows";
import type { ExternalPositions } from "./unified-positions/external-positions";
import { useRegistryPositions } from "./unified-positions/registry-positions";
import { RegistryPositionTool, RegistryRowCompound, type ToolBalance } from "./unified-positions/registry-tools";
import { RegistryPerformancePanel } from "./unified-positions/registry-performance";
import { RaydiumActivityRecords, RaydiumRowCompound } from "./compound-panel";
import { tokenSymbol } from "@/lib/position-label";
import { shortAddress } from "@/lib/format/address";
import { PortfolioSummary, PortfolioHistoryStatus } from "./portfolio/portfolio-summary";
import { PortfolioPositionList, rowActions, type PortfolioRow, type RowTool } from "./portfolio/portfolio-rows";
import { usePortfolioFigures } from "./portfolio/use-portfolio-figures";
import { portfolioTotals, type FiguresState, type PositionFigures } from "@/lib/portfolio/figures";

const short = shortAddress;
const money = (value: string, decimals: number, digits = 6) => formatAmount(value, decimals, digits);
const tokenLabel = (mint: string, kind?: "native" | "token") =>
  kind === "native" ? "SOL" : mint === USDC_MINT ? "USDC" : mint === NATIVE_SOL_MINT ? "WSOL" : short(mint);

export function SelectedApp({ initialView = "portfolio", initialMint: initialMintProp = "", initialWallet = "", previewPoolId = "", initialPositionKey: initialKeyProp = "", external, onRescan }: {
  /** `performance`: a Performance link (`?view=performance`, /app/position-performance) opens its position's detail. */
  initialView?: PortfolioView | "compound" | "deposit" | "withdraw";
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
  // One popup at a time. A close hides it, not its flow: panels keep their transaction state until another target opens.
  const [popup, setPopup] = useState<{ key: string; view: RowTool; open: boolean } | null>(null);
  // A position's Performance detail (the row click). Separate from the tool popup: it reads only, so it never moves the
  // selection or replaces a tool popup whose transaction is still running. `""`: a pool-only link (`?pool=`).
  const [detail, setDetail] = useState<string | null>(null);
  const [withdrawBusy,setWithdrawBusy]=useState(false);
  const controller = useSelectedController();
  const { restoring } = useWalletConnection();
  const { wallet, connected, connect, disconnect, connectionError,
    discovery, selection, state, amount, tolerancePercent, result, attempt, attemptStatus,
    error, reprepare, quoteError, quoteErrorCode, quoteErrorOutputMint, quoteErrorAmount, showQuoteRecalculate,
    busy: addBusy, retryAdd, calculating, now, quote, fresh, status, insufficientInput,
    actionLabel, actionDisabled: addDisabled, primaryAction: addAction, changeAmount, changeTolerance, fillMax,
    choosePosition, chooseAsset, refreshDiscovery, refreshState, retryCalculation,
    loadingDiscovery, loadingState, stateError } = controller;
  // My positions from DEXes served through the registry (PR5): every Solana-wallet DEX except the inline source above.
  const [registryRefresh, setRegistryRefresh] = useState(0);
  // A confirmed operation or Refresh re-reads one aggregate of all Portfolio numbers.
  const [reportsRefresh, setReportsRefresh] = useState(0);
  const refreshReports = () => setReportsRefresh((value) => value + 1);
  const registry = useRegistryPositions({ owner: connected ? wallet || null : null, signer: "solana-wallet", exclude: [positionSource.id], refresh: registryRefresh });
  const totalCostPercent = quote && typeof quote.roundtripCostInput === "string" && BigInt(quote.requested) > 0n
    ? (Number(quote.roundtripCostInput) / Number(quote.requested) * 100).toFixed(2)
    : null;
  // Read-only picks survive missing Add inputs, but never survive a wallet commit or removal.
  // Reconcile the controller before exposing any operation target, including the render before effects run.
  const { ownedPick, inlineMint, selectionAligned, setInlinePick } = useInlinePositionSelection({
    wallet, connected, discovery, selection, initialMint,
  });
  const pickPosition = (positionMint: string) => { setInlinePick({ wallet: wallet || "", mint: positionMint }); choosePosition(positionMint); };
  const compound = useCompoundController({ wallet: wallet || undefined, positionMint: selectionAligned ? selection?.positionMint : undefined,
    // Selection alignment gates positionMint above, not wallet-wide leftover recovery.
    externalBlocked: addBusy || withdrawBusy,
    // A confirmed compound changed this position's fees and value: read its Portfolio numbers again.
    onConfirmed: () => {
      void refreshState();
      refreshReports();
    } });
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
  const walletBalances: Record<string, ToolBalance> = Object.fromEntries((discovery?.assets ?? []).map((asset) => [asset.mint, { balance: asset.balance, decimals: asset.decimals }]));
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);
  // Old operation links land on Portfolio without starting anything. A Performance deep link opens its position detail.
  const activeView: ToolId = popup && popup.view !== "activity" ? popup.view : "deposit";
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
  // A deep link (?mint=) wins over the wallet's default selection until the user picks a position themselves. It is applied
  // once per wallet (the controller resets the selection whenever the wallet changes).
  const linkedPositionWallet = useRef("");
  useEffect(() => {
    if (!wallet || linkedPositionWallet.current === wallet || !initialMint || !discovery) return;
    if (discovery.positions.some((position) => position.positionMint === initialMint)) {
      linkedPositionWallet.current = wallet;
      // Already selected (the wallet's default, or a reload of the ?position= a popup wrote): re-choosing would clear
      // the amount and start a second state read.
      if (selection?.positionMint !== initialMint) choosePosition(initialMint);
    }
  }, [initialMint, discovery, wallet, selection, choosePosition]);
  // The exit estimate lives in the Withdraw tool: it reads the selected (held) position, not the Performance deep link.
  const exitTargetMint = !withdrawBusy && liveWithdraw ? liveWithdraw.positionMint : "";
  const nftAccountLookup = resolveNftAccountLookup({ connected, targetMint: exitTargetMint, discovery, state,
    loadingDiscovery, loadingState, hasError: Boolean(stateError) });
  const exitEstimate = exitTargetMint && liveWithdraw ? { positionMint: exitTargetMint, nftAccount: nftAccountLookup.account,
    pending: nftAccountLookup.pending, poolMints: [liveWithdraw.mintA, liveWithdraw.mintB] as const } : null;
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
    ? {
      // Keyed by the position only: the cross-op lock is per position and must not depend on the open tab (PM review of #289).
      tool: (item: UnifiedPosition, view: ToolId) => <RegistryPositionTool key={item.key} position={item} descriptor={registry.descriptor(item)!}
        capabilities={registry.capabilities(item)!} view={view} balances={walletBalances} symbolOf={(token) => tokenSymbol(token.id, metadata, token.symbol)}
        onConfirmed={() => { setOtherKey(item.key); setRegistryRefresh((value) => value + 1); void refreshDiscovery(); refreshReports(); }}
        showStockPerformance={false} />,
      capabilities: registry.capabilities(otherSelected)! }
    : otherSelected && external ? { tool: external.tool, capabilities: capabilitiesFor(external.source, otherSelected) }
      : null;
  const selectedSolana = solanaPositions.find((item) => item.nativeId === inlineMint) ?? null;
  const capabilities = otherSelected && otherBinding ? otherBinding.capabilities : capabilitiesFor(positionSource, selectedSolana);
  const unavailableReason = toolUnavailableReason(capabilities, activeView);
  const selectedKey = otherSelected?.key ?? (inlineMint ? positionKey(positionSource.id, inlineMint) : "");
  // Keep selection in the URL; only Performance deep-links auto-open a popup on reload. No operation runs from a URL.
  const writeUrl = (key: string, view?: "performance") => {
    if (!key || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("mint"); url.searchParams.delete("positionMint");
    url.searchParams.set("position", key);
    if (view) url.searchParams.set("view", view); else url.searchParams.delete("view");
    window.history.replaceState(window.history.state, "", url);
  };
  // Opening a popup on the position already selected keeps its Add inputs and quote.
  const selectItem = (item: UnifiedPosition) => {
    if (item.key === selectedKey) return;
    if (item.source !== positionSource.id) { setOtherKey(item.key); return; }
    setOtherKey("");
    // Already the controller's selection (its pick not owned yet, e.g. right after a reload): own it without re-choosing.
    if (selection?.positionMint === item.nativeId) setInlinePick({ wallet: wallet || "", mint: item.nativeId });
    else pickPosition(item.nativeId);
  };
  const closePopup = () => {
    setPopup((current) => current ? { ...current, open: false } : null);
    if (selectedKey) writeUrl(selectedKey);
  };
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
  const figureKeys = !connected || !wallet ? [] : [
    ...solanaPositions.filter((item) => !isClosed(item)).map((item) => item.key),
    ...registry.positions.filter((item) => !isClosed(item) && registry.capabilities(item)?.performance.supported).map((item) => item.key),
  ];
  const figures = usePortfolioFigures(connected ? wallet || null : null, figureKeys, {
    refresh: reportsRefresh, paused: loadingDiscovery || (!discovery && !stateError) || Boolean(registry.loading),
  });
  const reportedKeys = new Set(figureKeys);
  const capabilitiesOf = (item: UnifiedPosition): SourceCapabilities => item.source === positionSource.id ? capabilitiesFor(positionSource, item)
    : registry.owns(item) ? registry.capabilities(item)! : capabilitiesFor(external!.source, item);
  const figuresOf = (item: UnifiedPosition): PositionFigures | null => {
    if (!reportedKeys.has(item.key)) return external && item.chain === external.chain ? external.figures?.(item) ?? null : null;
    const loaded = figures[item.key];
    return loaded && loaded.status !== "failed" ? loaded.figures : null;
  };
  const portfolio = portfolioTotals(allPositions.filter((item) => !isClosed(item) && reportedKeys.has(item.key)).map((item): FiguresState => {
    const loaded = figures[item.key];
    return !loaded ? { status: "loading" } : loaded.status === "failed" ? { status: "failed" } : { status: "ready", figures: loaded.figures };
  }), allPositions.filter((item) => !isClosed(item) && !reportedKeys.has(item.key)).map((item) => figuresOf(item)?.valueUsd ?? null));
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
  // The selected panel's flow stays mounted after closing. A different target is blocked while any transaction runs.
  const popupRegistryLock = usePositionOpLock(popup?.key ?? "");
  const popupBusy = anyBusy || popupRegistryLock.busy || popupRegistryLock.cancelPending;
  const popupTarget = popup && allPositions.find((item) => item.key === popup.key);
  const popupAligned = Boolean(popupTarget && popup.key === selectedKey);
  const loadingPositions = connected && (loadingDiscovery || !discovery) && !stateError;
  const showEmpty = !allPositions.length && !loadingPositions && !registry.loadingNames.length;
  // Portfolio rows (every tool's list). On Performance, stock positions are covered by the overview above them.
  const sourceName = (item: UnifiedPosition) => item.source === positionSource.id ? positionSource.displayName
    : registry.owns(item) ? registry.optionSource(item, metadata).displayName : external?.source.displayName ?? "";
  const pairOf = (item: UnifiedPosition) => `${tokenSymbol(item.tokenA.id, metadata, item.tokenA.symbol || poolLabel(item.tokenA.id))} / ${tokenSymbol(item.tokenB.id, metadata, item.tokenB.symbol || poolLabel(item.tokenB.id))}`;
  // Compound's flow lives with its row (the existing controller for Raydium; usePositionTx for a registry DEX).
  const rowCompound = (item: UnifiedPosition): PortfolioRow["compound"] => {
    if (isClosed(item)) return undefined;
    if (item.source === positionSource.id) return function raydiumRowCompound(slot) { return <RaydiumRowCompound controller={compound}
      positionMint={item.nativeId} positionKey={item.key} slot={slot} tokenLabel={poolLabel} />; };
    const descriptor = registry.owns(item) ? registry.descriptor(item) : null;
    if (!descriptor || !registry.capabilities(item)?.compound.supported) return undefined;
    return function registryRowCompound(slot) { return <RegistryRowCompound position={item} descriptor={descriptor} slot={slot}
      symbolOf={(token) => tokenSymbol(token.id, metadata, token.symbol)}
      onConfirmed={() => { setRegistryRefresh((value) => value + 1); void refreshDiscovery(); refreshReports(); }} />; };
  };
  const portfolioRows = new Map<string, PortfolioRow>(groups.flatMap((group) => group.positions.map((item): [string, PortfolioRow] => {
    const figures = figuresOf(item);
    // Position number tells apart two positions in the same pair (an NFT mint shortened, an EVM token id as-is).
    const id = `#${String(item.nativeId).length > 12 ? short(String(item.nativeId)) : String(item.nativeId)}`;
    const pair = item.tokenA.id || item.tokenB.id ? pairOf(item) : "";
    const title = figures?.stock ?? (pair || `Position ${id}`);
    return [item.key, { item, figures, title,
      subtitle: [title !== pair ? pair : null, group.showSourceName ? sourceName(item) : null, title.endsWith(id) ? null : id].filter(Boolean).join(" · "),
      actions: rowActions(capabilitiesOf(item), isClosed(item), { activity: item.source === positionSource.id || registry.owns(item) }), compound: rowCompound(item),
      busy: selectedKey === item.key ? addBusy ? { tool: "deposit", label: "Adding…" } : withdrawBusy ? { tool: "withdraw", label: "Withdrawing…" } : undefined : undefined }];
  })));
  const openTool = (key: string, view: RowTool) => {
    const found = allPositions.find((item) => item.key === key || positionKeysEqual(item.key, key));
    if (!found) return;
    // Reopening the running operation is always safe; changing a target while a money flow runs is not.
    if (popupBusy && (popup?.key !== found.key || popup.view !== view)) return;
    selectItem(found);
    setPopup({ key: found.key, view, open: true });
    writeUrl(found.key);
  };
  const openDetail = (key: string) => { setDetail(key); writeUrl(key, "performance"); };
  const closeDetail = () => { setDetail(null); if (detail) writeUrl(detail); };
  // /app/position-performance and ?view=performance land on Portfolio; a position (or pool) link opens its detail once.
  const [autoOpened, setAutoOpened] = useState(false);
  if (!autoOpened && initialView === "performance") {
    const linked = initialPositionKey ? allPositions.find((item) => positionKeysEqual(item.key, initialPositionKey) || item.key === initialPositionKey)?.key
      : initialMint ? positionKey(positionSource.id, initialMint) : previewPoolId ? "" : undefined;
    if (linked !== undefined) { setAutoOpened(true); setDetail(linked); }
  }
  // Performance has no tab or page of its own, so $pageview cannot see it: counted each time a position's detail opens.
  useEffect(() => {
    if (detail !== null) captureGrowthEvent(GROWTH_EVENTS.performanceView);
  }, [detail]);
  // Session-only Activity: signed Add results and cleanup transactions (Compound records are also retained by its controller).
  useEffect(() => {
    if (!visibleAttempt) return;
    const status = attemptStatus === "success" ? "success" : attemptStatus === "failed" || attemptStatus === "expired" ? "failed" : "pending";
    recordActivity({ id: `add:${visibleAttempt.signature}`, positionKey: positionKey(positionSource.id, visibleAttempt.positionMint), signature: visibleAttempt.signature,
      status, title: status === "success" ? "Liquidity added" : status === "failed" ? "Add did not complete" : "Add confirming", detail: status === "failed" ? error || undefined : undefined });
  }, [visibleAttempt, attemptStatus, error]);
  useEffect(() => {
    if (!compound.cleanupBatch) return;
    for (const tx of compound.cleanupBatch.transactions) {
      if (tx.unsent || !tx.signature) continue;
      const status = tx.status === "success" ? "success" : tx.status === "pending" ? "pending" : "failed";
      recordActivity({ id: `cleanup:${tx.signature}`, positionKey: positionKey(positionSource.id, compound.positionMint || ""), signature: tx.signature,
        status, title: status === "success" ? "Harvest accounts cleaned" : status === "pending" ? "Cleanup confirming" : "Cleanup did not complete" });
    }
  }, [compound.cleanupBatch, compound.positionMint]);
  const renderPositionRows = () => <PortfolioPositionList groups={groups} rows={portfolioRows} disabled={popupBusy}
    popup={popup ? { key: popup.key, tool: popup.view, open: popup.open } : null}
    onOpenDetail={openDetail} onAction={openTool} onClosePopup={closePopup} />;
  const popupTitle = popup?.view === "deposit" ? "Add to position"
    : popup?.view === "withdraw" ? portfolioRows.get(popup.key)?.actions.some((action) => action.tool === "withdraw" && action.label === "Close") ? "Close position" : "Withdraw"
      : "Activity";
  const popupIsPanel = popup && popup.view !== "compound";
  const detailItem = detail ? allPositions.find((item) => item.key === detail || positionKeysEqual(item.key, detail)) ?? null : null;
  const detailParsed = detail ? parsePositionKey(detail) : null;
  // The inline Solana source's detail reads by its mint, held or not (a shared link shows public data).
  const detailMint = detail === "" ? "" : detailParsed?.source === positionSource.id ? detailParsed.nativeId : null;
  const detailForeign = Boolean(detailMint) && connected && discovery !== null && !loadingDiscovery
    && !discovery.positions.some((position) => position.positionMint === detailMint);
  const detailRow = detailItem ? portfolioRows.get(detailItem.key) : undefined;
  const detailWithdraw = detailItem && !isClosed(detailItem) && detailRow?.actions.length === 0 ? capabilitiesOf(detailItem).withdraw : null;
  const detailNoActionReason = detailWithdraw && !detailWithdraw.supported ? detailWithdraw.reason : null;
  const detailRegistry = detailItem && registry.owns(detailItem) ? { descriptor: registry.descriptor(detailItem)!, capabilities: registry.capabilities(detailItem)! } : null;
  const popupOpen = Boolean(popupIsPanel && popup.open);
  return <div className="min-h-screen bg-canvas text-cream">
    <div className="relative mx-auto max-w-[1280px] px-3 pb-32 pt-3 max-sm:pb-[max(8rem,calc(var(--tx-notice-bottom-offset,0px)+2rem))] sm:px-5 sm:pt-5">
      <InkNav wallet={wallet} connected={connected} restoring={restoring} onConnect={connect} onDisconnect={disconnect} />

      <div className="relative">
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 px-1">
        <h1 className="text-xl font-semibold text-cream sm:text-2xl">Portfolio</h1>
        <button type="button" disabled={(!wallet && !(external && onRescan)) || anyBusy} onClick={refreshAll}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/20 px-3 py-1.5 text-xs font-semibold text-cream/80 transition-colors hover:border-white/40 disabled:opacity-40">
          <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${loadingDiscovery || compound.loading ? "animate-spin motion-reduce:animate-none" : ""}`} />Refresh
        </button>
      </div>

      {allPositions.length > 0 && <PortfolioSummary totals={portfolio} />}
      {allPositions.length > 0 && <PortfolioHistoryStatus rows={figureKeys.flatMap((key) => figures[key] ? [figures[key]!] : [])} />}

      <section aria-labelledby="all-positions-heading" className="mt-3 rounded-[28px] border border-white/12 bg-char p-5 sm:p-7">
        <h2 id="all-positions-heading" className="mb-5 text-base font-semibold text-cream">All positions</h2>
        {showEmpty ? <PositionsEmptyState connected={connected} restoring={restoring} onConnect={connect} />
          : !allPositions.length ? <p role="status" className="text-sm text-smoke">Loading positions…</p>
          : <div>{renderPositionRows()}</div>}
        {registry.loadingNames.length ? <p role="status" className="mt-2 text-xs text-smoke" data-testid="registry-positions-loading">Loading {registry.loadingNames.join(", ")} positions…</p> : null}
        {registry.errors.map((message) => <p key={message} role="alert" className="mt-2 text-xs text-cream/80" data-testid="registry-positions-error">{message}</p>)}
        {external?.status}
      </section>
      </div>
      <InkFooter />
    </div>
    {popupIsPanel && <ActionDialog open={popupOpen} onClose={closePopup} title={popupTitle} testId={`${popup.view}-popup`}
      size={popup.view === "activity" ? "md" : "lg"}>
      <p className="mt-1 text-xs text-smoke" data-testid="popup-target" data-selected-key={selectedKey}>
        {selectedItem ? `${pairOf(selectedItem)} · #${short(selectedItem.nativeId)}` : null}</p>
      {!popupAligned ? <p role="status" className="mt-4 text-sm text-smoke">Loading position…</p>
        : popup.view === "activity" ? <ActivityList positionKey={popup.key} savedSignatures={popupTarget?.source === positionSource.id && compound.positionMint === popupTarget.nativeId
          ? [...(compound.attempt ? [compound.attempt.signature] : []), ...(compound.cleanup?.compoundSignature ? [compound.cleanup.compoundSignature] : []),
            ...(compound.cleanupBatch?.transactions.filter((tx) => !tx.unsent && tx.signature).map((tx) => tx.signature) ?? [])] : []} records={popupTarget?.source === positionSource.id
          ? <RaydiumActivityRecords controller={compound} positionMint={popupTarget.nativeId} tokenLabel={poolLabel} /> : undefined} />
        : unavailableReason ? <UnavailableTool id={`${activeView}-view`} reason={unavailableReason} />
        : otherSelected && otherBinding ? <div id={`${activeView}-view`}>{otherBinding.tool(otherSelected, activeView)}</div>
        : popup.view === "withdraw" ? <div id="withdraw-view">{shownWithdraw ? <WithdrawPanel key={`${shownWithdraw.wallet}:${shownWithdraw.positionMint}`}
            wallet={shownWithdraw.wallet} positionMint={shownWithdraw.positionMint} mintA={shownWithdraw.mintA} mintB={shownWithdraw.mintB}
            label={poolLabel} outputs={capabilities.withdrawOutputs} onClose={closePopup} onBusyChange={onWithdrawBusy}
            onConfirmed={() => { void refreshState(); void refreshDiscovery(); refreshReports(); }} />
          : <p className="mt-4 text-sm text-smoke">Connect your wallet and choose a position to withdraw.</p>}
          {shownWithdraw && exitEstimate && exitEstimate.positionMint === shownWithdraw.positionMint && <div data-testid="withdraw-exit-estimate" className="mt-3 rounded-[28px] border border-white/12 bg-char p-5 sm:p-7">
            <PositionExitEstimate key={exitEstimate.positionMint} positionId={exitEstimate.positionMint} nftAccount={exitEstimate.nftAccount}
              nftAccountPending={exitEstimate.pending} autoExit poolMints={exitEstimate.poolMints} className="border-t-0! pt-0!" />
          </div>}
        </div>
        : <AddLiquiditySection
          hidden={false}
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
      {popup.view === "deposit" && <p className="mt-4 text-xs leading-5 text-smoke">Different tokens may have issuer, transfer restriction or routing liquidity risks.{" "}
        <Link href={DOCS_ROUTES.risks} className="text-lemon underline underline-offset-2 hover:text-[#fff27f]">Read the Risks docs</Link> before adding liquidity.</p>}
    </ActionDialog>}
    {detail !== null && <ActionDialog open onClose={closeDetail} title={detailRow?.title ?? "Position performance"} testId="performance-popup" size="lg">
      {detailRow?.subtitle ? <p className="mt-1 text-xs text-smoke">{detailRow.subtitle}</p> : null}
      {detailItem && isClosed(detailItem) && <p className="mt-3 w-fit rounded-full border border-white/20 px-2.5 py-1 text-xs font-semibold text-smoke" data-testid="position-closed">{CLOSED_LABEL}: no liquidity left</p>}
      {/* A row with no operation buttons says why here (it was a greyed tab before LJ 11/14). */}
      {detailNoActionReason && <UnavailableTool id="detail-unavailable" reason={detailNoActionReason} />}
      <div id="performance-view" className="mt-3 space-y-3">
        {detailForeign && <p role="status" className="rounded-2xl border border-white/15 bg-white/[0.04] px-4 py-3 text-xs leading-5 text-smoke">
          Showing the linked position {short(detailMint!)}. It is not held by the connected wallet, so only public data is shown.
        </p>}
        {detailMint !== null ? <PositionPerformancePanel key={detailMint} embedded selectedMint={detailMint} initialWallet={initialWallet} previewPoolId={previewPoolId} />
          : detailItem && detailRegistry ? detailRegistry.capabilities.performance.supported
            ? <RegistryPerformancePanel key={detailItem.key} position={detailItem} descriptor={detailRegistry.descriptor} />
            : <UnavailableTool id="performance-unavailable" reason={detailRegistry.capabilities.performance.reason} />
          : detailItem && external && detailItem.chain === external.chain ? <>{external.header(detailItem)}<div className="mt-3 space-y-1 text-xs text-smoke">{external.details(detailItem)}</div></>
          : <p role="status" className="text-sm text-smoke">Loading position…</p>}
      </div>
    </ActionDialog>}
    <TransactionStatusDialog attempt={visibleAttempt} status={attemptStatus} error={error} open={statusDialogOpen}
      onOpenChange={setStatusDialogOpen}
      onRetry={selectionAligned && !busy && retryAdd ? () => { if (!selectionAligned || busy) return; setStatusDialogOpen(false); retryAdd(); } : undefined} />

  </div>;
}

/** The one empty state of All positions: one sentence and the way to Pools (plus Connect while no wallet is connected). */
function PositionsEmptyState({ connected, restoring, onConnect }: { connected: boolean; restoring?: boolean; onConnect: () => void }) {
  return <div data-testid="positions-empty-state" className="rounded-2xl border border-white/12 bg-white/[0.03] p-4 sm:p-5">
    <p className="text-sm leading-6 text-cream/80">{connected ? "No positions in this wallet yet." : "Connect your wallet to see your positions."}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {!connected && <button type="button" onClick={onConnect} disabled={restoring} aria-busy={restoring || undefined} className="rounded-full bg-lemon px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-[#fff27f] disabled:cursor-wait disabled:opacity-60">{restoring ? "Connecting…" : "Connect wallet"}</button>}
      <a href={APP_ROUTES.rwaPairs} className="rounded-full border border-white/25 px-4 py-2 text-sm font-semibold text-cream transition-colors hover:border-white/50 hover:bg-white/[0.04]">Go to Pools</a>
    </div>
  </div>;
}
