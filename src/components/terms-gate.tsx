"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { WalletConnectionContext, useWalletConnection } from "./wallet-connection";
import { hasAcceptedTerms, recordTermsAcceptance, TERMS_ATTESTATION, TERMS_PATH, TERMS_STORAGE_KEY } from "@/lib/terms-acceptance";

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === TERMS_STORAGE_KEY) listener(); };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
};

/**
 * Requires the restricted-region / Terms attestation before the first wallet connect.
 * - `connect()` opens the attestation dialog until it has been accepted in this browser.
 * - A wallet that auto-reconnects before acceptance is also asked (or can disconnect).
 */
export function TermsGate({ children }: { children: ReactNode }) {
  const inner = useWalletConnection();
  const accepted = useSyncExternalStore(subscribe, () => hasAcceptedTerms(), () => true);
  const [requested, setRequested] = useState(false);
  const [checked, setChecked] = useState(false);
  const open = !accepted && (requested || inner.connected);

  const accept = () => {
    if (!checked) return;
    recordTermsAcceptance();
    listeners.forEach((listener) => listener());
    const wasRequested = requested;
    setRequested(false);
    if (wasRequested && !inner.connected) inner.connect();
  };
  const cancel = () => {
    setRequested(false);
    setChecked(false);
    if (inner.connected) inner.disconnect();
  };

  return <WalletConnectionContext.Provider value={{ ...inner, connect: () => { if (hasAcceptedTerms()) inner.connect(); else setRequested(true); } }}>
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
          <button type="button" onClick={cancel} className="rounded-full border border-white/25 px-4 py-2.5 text-sm font-semibold text-cream hover:border-white/50">{inner.connected ? "Disconnect" : "Cancel"}</button>
          <button type="button" onClick={accept} disabled={!checked} className="rounded-full bg-lemon px-5 py-2.5 text-sm font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-40">{inner.connected ? "Continue" : "Continue to wallet"}</button>
        </div>
      </div>
    </div>}
  </WalletConnectionContext.Provider>;
}
