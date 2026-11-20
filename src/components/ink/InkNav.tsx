"use client";

import { Wallet } from "lucide-react";
import { cn } from "@/lib/cn";
import { useOptionalEvmWalletConnection } from "@/components/evm-wallet-connection";
import { RHC_CHAIN_ID } from "@/lib/rhc-wallet/eip1193";
import { shortAddress } from "@/lib/format/address";

export interface InkNavProps {
  wallet?: string | null;
  connected?: boolean;
  restoring?: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

const short = shortAddress;
const shortEvm = shortAddress;

const walletPill = "flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border px-2.5 text-[13px] sm:gap-2 sm:px-4 font-medium outline-none transition-colors focus-visible:border-lemon";
const walletOff = "border-white/25 text-cream/85 hover:border-white/70";
const walletOn = "border-white/40 text-cream hover:border-white/70";

/**
 * App wallet slot for SiteHeader: Solana and EVM stay independent. No nav links (those live in SiteHeader).
 * Wallet buttons only render when the page passes Solana handlers; plan/sign pages without handlers show none.
 */
export function InkNav({ wallet, connected, restoring = false, onConnect, onDisconnect }: InkNavProps) {
  const evm = useOptionalEvmWalletConnection();
  const showSolana = Boolean(onConnect && onDisconnect);
  const showEvm = showSolana && Boolean(evm?.enabled);
  const solanaConnected = Boolean(connected && wallet);
  const evmBusy = evm?.status === "connecting" || evm?.status === "restoring";
  const evmOnRhc = evm?.chainId === RHC_CHAIN_ID;

  if (!showSolana) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <div className="flex min-w-0 gap-2" data-testid="nav-wallets">
        <button
          type="button"
          onClick={solanaConnected ? onDisconnect : onConnect}
          disabled={!solanaConnected && restoring}
          aria-busy={!solanaConnected && restoring ? true : undefined}
          title={solanaConnected ? "Disconnect Solana wallet" : restoring ? "Restoring Solana wallet…" : "Connect a Solana wallet (Phantom, Solflare, …)"}
          aria-label={solanaConnected && wallet ? `Solana wallet ${short(wallet)}, connected. Disconnect` : "Connect a Solana wallet"}
          data-testid="nav-solana-wallet"
          data-connected={solanaConnected ? "true" : "false"}
          className={cn(walletPill, solanaConnected ? walletOn : walletOff, !solanaConnected && restoring && "disabled:cursor-wait disabled:opacity-60")}
        >
          <Wallet className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden="true" />
          {solanaConnected && wallet ? <WalletLabel address={short(wallet)} chain="SOL" /> : <span className="shrink-0">{restoring ? "Connecting…" : "Solana"}</span>}
        </button>
        {/* No network tag or switch here (LJ 11/14): another network is only asked about where it matters (RHC Close).
            The address shows a chain tag only on Robinhood Chain. */}
        {showEvm && evm && (
          <button
            type="button"
            onClick={evm.wallet ? evm.disconnect : () => { evm.dismissError(); void evm.connect().catch(() => {}); }}
            disabled={evmBusy}
            title={evm.wallet ? "Disconnect EVM wallet" : "Connect an EVM wallet (MetaMask) for Robinhood Chain"}
            aria-label={evm.wallet ? `EVM wallet ${shortEvm(evm.wallet.address)}${evmOnRhc ? " on Robinhood Chain" : ""}, connected. Disconnect` : "Connect an EVM wallet"}
            data-testid="nav-evm-wallet"
            data-connected={evm.wallet ? "true" : "false"}
            className={cn(walletPill, evm.wallet ? walletOn : walletOff, "disabled:cursor-wait disabled:opacity-60")}
          >
            <Wallet className="hidden h-4 w-4 shrink-0 sm:block" aria-hidden="true" />
            {evm.wallet
              ? <WalletLabel address={shortEvm(evm.wallet.address)} chain={evmOnRhc ? "RHC" : null} />
              : <span className="shrink-0">{evm.status === "connecting" ? "Connecting…" : "EVM"}</span>}
          </button>
        )}
      </div>
      {showEvm && evm?.error && (
        <p role="alert" className="w-full text-right text-xs text-red-200" data-testid="nav-evm-error">
          <span>EVM wallet: {evm.error}</span>
          {" "}
          <button type="button" onClick={evm.dismissError} className="underline underline-offset-2">Dismiss</button>
        </p>
      )}
    </div>
  );
}

// Short visible labels with no CSS ellipsis: disconnected pills say "Solana" / "EVM"; connected pills show the whole
// short address. Icons stay at sm+ so the 375 row (logo + two pills + Menu) can keep every label visible. The chain
// tag hides below sm for the same reason (it remains in the accessibility name).
function WalletLabel({ address, chain }: { address: string; chain: string | null }) {
  return <>
    <span className="shrink-0 font-data text-[12px]">{address}</span>
    {chain && <span className="hidden shrink-0 rounded-full bg-white/12 px-1.5 py-px text-[10px] font-semibold leading-4 tracking-wide text-cream/80 sm:inline">{chain}</span>}
  </>;
}
