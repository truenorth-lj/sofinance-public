"use client";

import { type Dispatch, type RefObject } from "react";
import { loadCompoundReceipts, persistCompoundReceipt, type CompoundReceipt } from "@sofinance/engine/compound-attempt";
import { post } from "./compound-client";
import {
  emptyCompoundError, emptyCompoundScan, type CompoundControllerAction, type CompoundScanState,
} from "./compound-controller-state";

type DiscoveryPage = { wallet: string; receipts: CompoundReceipt[]; nextCursor: string | null; scanned: number;
  totalCandidates: number; incomplete: boolean; errors: number };

type Options = {
  wallet?: string;
  identity: string;
  busy: boolean;
  importing: boolean;
  scan: CompoundScanState;
  dispatch: Dispatch<CompoundControllerAction>;
  mounted: RefObject<boolean>;
  walletRef: RefObject<string | undefined>;
  scanRequest: { current: number };
  scanRunning: { current: boolean };
  submitting: { current: boolean };
  operationRequest: { current: number };
};

export function useCleanupScan({
  wallet, identity, busy, importing, scan, dispatch, mounted, walletRef, scanRequest, scanRunning, submitting, operationRequest,
}: Options) {
  async function scanWallet(restart = false) {
    if (!wallet || scanRunning.current || busy || submitting.current) return;
    const requestedWallet = wallet;
    const requestId = ++scanRequest.current;
    let cursor = restart ? null : scan.cursor;
    let scanned = restart ? 0 : scan.scanned;
    scanRunning.current = true;
    dispatch({ type: "scan/patch", updater: (previous) => ({ ...(restart ? emptyCompoundScan : previous), started: true, scanning: true, error: "" }) });
    try {
      for (let page = 0; page < 20; page++) {
        const response = await post<DiscoveryPage>("/api/compound-recover-discover", { wallet: requestedWallet, ...(cursor ? { cursor } : {}) });
        if (!mounted.current || walletRef.current !== requestedWallet || requestId !== scanRequest.current) return;
        if (response.wallet !== requestedWallet || !Array.isArray(response.receipts) || response.receipts.some(item => item.wallet !== requestedWallet)) {
          throw new Error("Harvest account query does not match connected wallet");
        }
        for (const receipt of response.receipts) persistCompoundReceipt(window.localStorage, receipt);
        dispatch({ type: "receipts/set", receipts: loadCompoundReceipts(window.localStorage, requestedWallet).receipts });
        const incomplete = response.incomplete || response.errors > 0;
        scanned += response.scanned;
        const nextCursor = response.nextCursor;
        dispatch({
          type: "scan/set",
          scan: { started: true, scanning: !incomplete && !!nextCursor && page < 19, cursor: nextCursor,
            scanned, total: response.totalCandidates, incomplete,
            error: incomplete ? "Some accounts could not be verified. Retry the scan before treating it as complete." : "" },
        });
        if (incomplete || !nextCursor) return;
        if (nextCursor === cursor) throw new Error("Account scan did not advance. Please retry.");
        cursor = nextCursor;
      }
    } catch (caught) {
      if (mounted.current && walletRef.current === requestedWallet && requestId === scanRequest.current) {
        dispatch({ type: "scan/patch", updater: (previous) => ({ ...previous, scanning: false, incomplete: true,
          error: caught instanceof Error ? caught.message : "Unable to scan harvest accounts. Please retry." }) });
      }
    } finally { scanRunning.current = false; }
  }

  const canImport = !!wallet && !busy && !importing;
  async function importReceipt(signature: string) {
    if (!wallet || !canImport || submitting.current) return;
    const requestedWallet = wallet;
    const requestedOperation = operationRequest.current;
    const requestedSignature = signature.trim();
    const requestedIdentity = identity;
    dispatch({ type: "importing/set", importing: true });
    dispatch({ type: "error/set", error: emptyCompoundError });
    try {
      const response = await post<{ receipt: CompoundReceipt }>("/api/compound-recover-import", {
        wallet: requestedWallet, signature: requestedSignature,
      });
      if (!mounted.current || walletRef.current !== requestedWallet || operationRequest.current !== requestedOperation) return;
      if (response.receipt.wallet !== requestedWallet || response.receipt.sourceSignature !== requestedSignature) {
        throw new Error("Harvest account and query wallet or transaction signature mismatch");
      }
      persistCompoundReceipt(window.localStorage, response.receipt);
      dispatch({ type: "receipts/set", receipts: loadCompoundReceipts(window.localStorage, requestedWallet).receipts });
    } catch (caught) {
      if (mounted.current && walletRef.current === requestedWallet && operationRequest.current === requestedOperation) {
        dispatch({
          type: "error/set",
          error: {
            message: caught instanceof Error ? caught.message : "Harvest account query failed",
            identity: requestedIdentity, signature: null, receiptSignature: null,
          },
        });
      }
    } finally { if (mounted.current && walletRef.current === requestedWallet) dispatch({ type: "importing/set", importing: false }); }
  }

  return { scanWallet, importReceipt, canImport };
}
