"use client";

import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { ExitFlowResult, PositionLookup, RhcPositionView } from "@sofinance/engine/protocols/uniswap-v4/exit-flow";
import type { ScannedPosition } from "@sofinance/engine/protocols/uniswap-v4/position-scan";
import { useState } from "react";
import { type Eip1193Provider, guardedWalletRequest } from "@/lib/rhc-wallet/eip1193";
import { checkExitTx, EXIT_EXPIRED_MESSAGE, isDeadlinePassed } from "@/lib/rhc-wallet/exit-execute";
import { requireRobinhoodChain, waitForReceipt, walletTxParams } from "@/lib/rhc-wallet/open-execute";

/**
 * Robinhood Chain (4663) Uniswap v4 positions: the server reads (scan + lookups) and the full Close flow, shared by the pools
 * page panel (`RhcUniv4PositionsPanel`) and `/app` My positions (unified positions). Moved out of the panel unchanged.
 */
export type RhcWalletRef = { provider: Eip1193Provider; address: `0x${string}` };
export type RhcCloseReady = Extract<ExitFlowResult, { state: "ready" }>;
export type RhcCloseSent = { tokenId: string; hash: string; status: "pending" | "success" | "reverted" | "timeout"; expected: RhcCloseReady["expected"] };
type Ready = RhcCloseReady;
type CloseSent = RhcCloseSent;

export const poolOf = (p: RhcPositionView) => UNIV4_RHC_ALLOWLISTED_POOLS.find(x => x.poolId.toLowerCase() === p.poolId?.toLowerCase()) ?? null;

export async function postExit<T>(body: unknown): Promise<T> {
  const response = await fetch("/api/rhc-univ4-exit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => null) as (T & { state?: string }) | { error?: string } | null;
  if (json && "state" in json && json.state) return json as T;
  if (response.status === 404) throw new Error("Closing positions is not available on this deployment.");
  throw new Error(json && "error" in json && json.error ? json.error : "SoFinance could not reach Robinhood Chain right now. Please try again in a moment.");
}

export async function fetchPositions(address: string, ids: string[]): Promise<{ lookups: PositionLookup[]; error: string | null }> {
  if (!ids.length) return { lookups: [], error: null };
  try {
    const body = await postExit<{ state: "positions"; positions: PositionLookup[] }>({ action: "positions", user: address, tokenIds: ids });
    return { lookups: Array.isArray(body.positions) ? body.positions : [], error: null };
  } catch (e) { return { lookups: [], error: e instanceof Error ? e.message : "Could not load positions" }; }
}

export type Scan = { positions: ScannedPosition[]; error: string | null };
const SCAN_ERROR = "Couldn't check this wallet's Robinhood Chain positions right now. Positions saved in this browser and added by number are still shown.";

export async function fetchScan(address: string, fresh = false): Promise<Scan> {
  try {
    const response = await fetch(`/api/rhc-univ4-positions?wallet=${address}${fresh ? "&fresh=1" : ""}`, { cache: "no-store" });
    const json = await response.json().catch(() => null) as { state?: string; positions?: ScannedPosition[]; error?: string } | null;
    if (response.ok && json?.state === "scan" && Array.isArray(json.positions)) return { positions: json.positions, error: null };
    return { positions: [], error: response.status === 429 ? "Too many checks from this browser. Try again in a minute." : json?.error || SCAN_ERROR };
  } catch { return { positions: [], error: SCAN_ERROR }; }
}

/** Preview (server prepare + simulation) → client guards → one `eth_sendTransaction` → receipt → `onClosed`. */
export function useRhcClose({ wallet, receiptPoll, onClosed }: {
  wallet: RhcWalletRef | null; receiptPoll?: { intervalMs?: number; timeoutMs?: number }; onClosed?: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [ready, setReady] = useState<Ready | null>(null);
  const [error, setError] = useState<{ tokenId: string; message: string } | null>(null);
  const [sent, setSent] = useState<CloseSent | null>(null);

    const preview = async (tokenId: string) => {
      setBusy(tokenId); setError(null); setReady(null); setSent(null);
      try {
        const body = await postExit<ExitFlowResult>({ action: "prepare", user: wallet!.address, tokenId });
        if (body.state === "failed") throw new Error(body.message);
        setReady(body);
      } catch (e) { setError({ tokenId, message: e instanceof Error ? e.message : "Close preview failed" }); } finally { setBusy(null); }
    };

    const confirm = async () => {
      if (!ready) return;
      const tokenId = ready.position.tokenId;
      setBusy(tokenId); setError(null);
      try {
        if (isDeadlinePassed(ready.deadline)) { setReady(null); throw new Error(EXIT_EXPIRED_MESSAGE); }
        checkExitTx(ready.tx, wallet!.address, tokenId, poolOf(ready.position)!);
        await requireRobinhoodChain(wallet!.provider);
        const hash = await guardedWalletRequest(wallet!.provider, "eth_sendTransaction", [walletTxParams(ready.tx)]);
        if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Your wallet did not return a transaction hash. Check the wallet's activity before trying again.");
        const expected = ready.expected;
        setReady(null);
        setSent({ tokenId, hash, status: "pending", expected });
        const receipt = await waitForReceipt(wallet!.provider, hash, receiptPoll);
        const status: CloseSent["status"] = !receipt ? "timeout" : receipt.status === "0x1" ? "success" : "reverted";
        setSent({ tokenId, hash, status, expected });
        if (status !== "timeout") await onClosed?.();
      } catch (e) { setError({ tokenId, message: e instanceof Error ? e.message : "Close failed" }); } finally { setBusy(null); }
    };

  return { busy, ready, setReady, error, sent, preview, confirm };
}
