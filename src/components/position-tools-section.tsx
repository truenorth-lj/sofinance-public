"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, ChartNoAxesCombined, Sprout } from "lucide-react";
import { ActionSelector } from "./action-selector";
import type { CompoundController } from "./use-compound-controller";
import { PositionPerformancePanel } from "./position-performance-panel";
import { PositionExitEstimate } from "./position-exit-estimate";
import { WithdrawPanel } from "./withdraw-panel";
import { UnavailableTool } from "./unified-positions/unavailable-tool";
import { toolOptions, type ToolMeta } from "@/lib/unified-positions/capabilities";
import { shortAddress } from "@/lib/format/address";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import type { SourceCapabilities, ToolId, UnifiedPosition } from "@/lib/unified-positions/model";

/** `compound` has no tab (LJ 11/14): Compound runs from the position's row. Its entry only satisfies the tool record. */
export const TOOL_META: Readonly<Record<ToolId, ToolMeta>> = Object.freeze({
  compound: { label: "Compound", icon: Sprout, controls: "" },
  performance: { label: "Performance", icon: ChartNoAxesCombined, controls: "performance-view" },
  deposit: { label: "Add to position", icon: ArrowDown, controls: "deposit-view" },
  withdraw: { label: "Withdraw", icon: ArrowUp, controls: "withdraw-view" },
});

export type OtherBinding = {
  tool: (item: UnifiedPosition, view: ToolId) => ReactNode;
};

export type ShownWithdraw = {
  wallet: string;
  positionMint: string;
  mintA: string;
  mintB: string;
};

export function PositionToolsSection({
  activeView,
  onChangeView,
  capabilities,
  otherSelected,
  state,
  wallet,
  busy,
  unavailableReason,
  otherBinding,
  shownWithdraw,
  poolLabel,
  onCloseWithdraw,
  onWithdrawBusy,
  onWithdrawConfirmed,
  compound,
  linkedForeignPosition,
  initialMint,
  performanceMint,
  exitEstimate,
  initialWallet,
  previewPoolId,
  stockShownInOverview,
  onPerformanceResult,
  addLiquidity,
  showTools,
  children,
}: {
  activeView: ToolId;
  onChangeView: (view: ToolId) => void;
  capabilities: SourceCapabilities;
  otherSelected: UnifiedPosition | null;
  state: { positionMint?: string } | null;
  wallet: string;
  busy: boolean;
  unavailableReason: string | null | undefined;
  otherBinding: OtherBinding | null;
  shownWithdraw: ShownWithdraw | null;
  poolLabel: (mint: string) => string;
  onCloseWithdraw: () => void;
  onWithdrawBusy: (busy: boolean) => void;
  onWithdrawConfirmed: () => void;
  compound: CompoundController;
  linkedForeignPosition: boolean;
  initialMint: string;
  performanceMint: string;
  /** Exit estimate shown in the Withdraw tool for the selected Solana position (null while a withdrawal runs). */
  exitEstimate: { positionMint: string; nftAccount: string | undefined; pending: boolean; poolMints: readonly [string, string] } | null;
  initialWallet: string;
  previewPoolId: string;
  stockShownInOverview: boolean;
  onPerformanceResult: (mint: string, result: { report: PositionPerformanceReport | null; error: boolean }) => void;
  addLiquidity: ReactNode;
  /** A position is selected (or a Performance deep link is shown): render the tool panel below the position list. */
  showTools: boolean;
  /** The position list; the tool tabs are handed in so they sit inside the selected position's detail. */
  children: (tabs: ReactNode) => ReactNode;
}) {
  // No "Compound fees" tab (LJ 11/14): Compound is the position row's button.
  const tabs = <ActionSelector value={activeView} onChange={onChangeView} options={toolOptions(capabilities, TOOL_META,
    otherSelected ? {} : { withdraw: !state || !wallet || (busy && activeView !== "withdraw") }).filter((option) => option.value !== "compound")} />;
  return <>
    {children(tabs)}
    {!showTools ? null : unavailableReason ? <UnavailableTool id={`${activeView}-view`} reason={unavailableReason} />
      : otherSelected && otherBinding ? <div id={`${activeView}-view`}>{otherBinding.tool(otherSelected, activeView)}</div> : <>
      {activeView === "withdraw" && <div id="withdraw-view">{shownWithdraw ? <WithdrawPanel key={`${shownWithdraw.wallet}:${shownWithdraw.positionMint}`} wallet={shownWithdraw.wallet} positionMint={shownWithdraw.positionMint} mintA={shownWithdraw.mintA} mintB={shownWithdraw.mintB} label={poolLabel} outputs={capabilities.withdrawOutputs} onClose={onCloseWithdraw} onBusyChange={onWithdrawBusy} onConfirmed={onWithdrawConfirmed} /> : <p className="mt-4 text-sm text-smoke">Connect your wallet and choose a position to withdraw.</p>}
        {shownWithdraw && exitEstimate && exitEstimate.positionMint === shownWithdraw.positionMint && <div data-testid="withdraw-exit-estimate" className="mt-3 rounded-[28px] border border-white/12 bg-char p-5 sm:p-7">
          <PositionExitEstimate key={exitEstimate.positionMint} positionId={exitEstimate.positionMint} nftAccount={exitEstimate.nftAccount}
            nftAccountPending={exitEstimate.pending} autoExit poolMints={exitEstimate.poolMints} className="border-t-0! pt-0!" />
        </div>}</div>}
      {compound.historyWarning && <div role="status" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-xs text-cream/80"><span>{compound.historyWarning}</span></div>}
      <main>
        <div id="performance-view" hidden={activeView !== "performance"} className="mt-3 space-y-3">
          {activeView === "performance" && linkedForeignPosition && <p role="status" className="rounded-2xl border border-white/15 bg-white/[0.04] px-4 py-3 text-xs leading-5 text-smoke">
            Showing the linked position {shortAddress(initialMint)}. It is not held by the connected wallet, so only public data is shown.
          </p>}
          {activeView === "performance" && <PositionPerformancePanel embedded showStockPerformance={!stockShownInOverview} selectedMint={performanceMint}
            onResult={onPerformanceResult} initialWallet={initialWallet} previewPoolId={previewPoolId} />}
        </div>
        {addLiquidity}
      </main>
      </>}
  </>;
}
