"use client";

import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { WalletConnectionContext, useWalletConnection } from "./wallet-connection";
import { EvmWalletContext, useOptionalEvmWalletConnection, type EvmWalletConnection } from "./evm-wallet-connection";
import { WalletRequestError } from "@/lib/rhc-wallet/eip1193";
import type { EvmWallet } from "@/lib/rhc-wallet/evm-session";
import { hasAcceptedTerms, recordTermsAcceptance, TERMS_ATTESTATION, TERMS_PATH, TERMS_STORAGE_KEY } from "@/lib/terms-acceptance";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === TERMS_STORAGE_KEY) listener(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
};

/**
 * Requires the "I have read and agree to the Terms" checkbox before the first wallet connect, Solana or EVM.
 * Pure UX gate: no geo / IP check, no region logic. Acceptance persists in localStorage per browser (one acceptance
 * covers both wallets).
 * - `connect()` (Solana) and the EVM `connect()` open the attestation dialog until it has been accepted in this browser.
 *   The EVM connect resolves once the wallet connects after Continue, or rejects on Cancel.
 * - A wallet (either one) that auto-reconnects before acceptance is also asked (or can disconnect).
 */
export function TermsGate({ children }: { children: ReactNode }) {
  const inner = useWalletConnection();
  const evm = useOptionalEvmWalletConnection();
  const accepted = useSyncExternalStore(subscribe, () => hasAcceptedTerms(), () => true);
  const [requested, setRequested] = useState(false);
  const [evmRequested, setEvmRequested] = useState(false);
  const evmPending = useRef<{ promise: Promise<EvmWallet>; resolve: (wallet: EvmWallet) => void; reject: (error: unknown) => void } | null>(null);
  const [checked, setChecked] = useState(false);
  const anyConnected = inner.connected || Boolean(evm?.wallet);
  const open = !accepted && (requested || evmRequested || anyConnected);

  const evmConnect = evm?.connect;
  const connectEvm = useCallback((): Promise<EvmWallet> => {
    if (!evmConnect) return Promise.reject(new WalletRequestError("unknown", "EVM wallet is unavailable"));
    if (hasAcceptedTerms()) return evmConnect();
    if (!evmPending.current) {
      let resolve!: (wallet: EvmWallet) => void; let reject!: (error: unknown) => void;
      const promise = new Promise<EvmWallet>((res, rej) => { resolve = res; reject = rej; });
      evmPending.current = { promise, resolve, reject };
      setEvmRequested(true);
    }
    return evmPending.current.promise;
  }, [evmConnect]);
  const evmValue = useMemo<EvmWalletConnection | null>(() => evm ? { ...evm, connect: connectEvm } : null, [evm, connectEvm]);

  const accept = () => {
    if (!checked) return;
    recordTermsAcceptance();
    listeners.forEach((listener) => listener());
    const wasRequested = requested;
    const evmWaiting = evmPending.current;
    evmPending.current = null;
    setRequested(false);
    setEvmRequested(false);
    if (wasRequested && !inner.connected) inner.connect();
    if (evmWaiting && evmConnect) evmConnect().then(evmWaiting.resolve, evmWaiting.reject);
  };
  const cancel = () => {
    setRequested(false);
    setEvmRequested(false);
    setChecked(false);
    evmPending.current?.reject(new WalletRequestError("rejected", "Wallet connection was cancelled"));
    evmPending.current = null;
    if (inner.connected) inner.disconnect();
    if (evm?.wallet) evm.disconnect();
  };

  return <EvmWalletContext.Provider value={evmValue}><WalletConnectionContext.Provider value={{ ...inner, connect: () => { if (hasAcceptedTerms()) inner.connect(); else setRequested(true); } }}>
    {children}
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="terms-gate-title" className="w-full max-w-md rounded-[28px] border border-white/12 bg-char p-6 text-cream sm:p-7">
        <h2 id="terms-gate-title" className="text-lg font-semibold">Before you connect</h2>
        <p className="mt-2 text-sm leading-6 text-smoke">SoFinance is self-custodial software. You sign every transaction yourself in your wallet.</p>
        <label className="mt-5 flex items-start gap-3 text-sm leading-6 text-cream/90">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-lemon)]" />
          <span>{TERMS_ATTESTATION.replace(/Terms of Service$/, "")}<a href={TERMS_PATH} target="_blank" rel="noreferrer" className="underline underline-offset-4">Terms of Service</a>.</span>
        </label>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={cancel} className="rounded-full border border-white/25 px-4 py-2.5 text-sm font-semibold text-cream hover:border-white/50">{anyConnected ? "Disconnect" : "Cancel"}</button>
          <button type="button" onClick={accept} disabled={!checked} className="rounded-full bg-lemon px-5 py-2.5 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40">{anyConnected ? "Continue" : "Continue to wallet"}</button>
        </div>
      </div>
    </div>}
  </WalletConnectionContext.Provider></EvmWalletContext.Provider>;
}
