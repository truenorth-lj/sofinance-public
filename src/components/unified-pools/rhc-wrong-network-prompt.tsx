"use client";

import { useEffect, useRef, useState } from "react";
import { useEvmWalletConnection } from "../evm-wallet-connection";

/**
 * Shown by the Robinhood Chain sections (My positions block, Open position dialog) instead of their normal content while
 * the nav's EVM wallet is connected but on another network. The button calls `ensureRobinhoodChain` (switch, or add the
 * chain then switch) through the shared EVM session, so the nav and every section update together.
 */
export function RhcWrongNetworkPrompt({ purpose }: { purpose: string }) {
  const evm = useEvmWalletConnection();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const address = evm.wallet ? `${evm.wallet.address.slice(0, 6)}…${evm.wallet.address.slice(-4)}` : "";
  const switchNetwork = () => {
    setBusy(true);
    evm.switchNetwork().catch(() => { /* shown below from the session's error */ }).finally(() => { if (mounted.current) setBusy(false); });
  };
  return <div role="status" data-testid="rhc-wrong-network" className="mt-4 rounded-2xl border border-amber-300/30 bg-amber-300/[0.06] p-4">
    <p className="text-sm font-semibold text-amber-100">Wrong network</p>
    <p className="mt-1 text-xs leading-5 text-cream/80">
      Your EVM wallet{address ? ` (${address})` : ""} is on another network. Switch to Robinhood Chain to {purpose}.
    </p>
    <button type="button" onClick={switchNetwork} disabled={busy}
      className="mt-3 rounded-full bg-amber-300 px-4 py-2 text-sm font-semibold text-ink outline-none hover:bg-amber-200 focus-visible:shadow-[0_0_0_3px_var(--color-lilac)] disabled:cursor-wait disabled:opacity-60">
      {busy ? "Switching…" : "Switch to Robinhood Chain"}
    </button>
    {evm.error && <p role="alert" className="mt-2 text-xs text-red-200">{evm.error}</p>}
  </div>;
}
