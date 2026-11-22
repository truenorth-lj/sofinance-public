"use client";

import { useEffect, useRef } from "react";
import { Providers } from "@/components/providers";
import { useOptionalEvmWalletConnection } from "@/components/evm-wallet-connection";
import { useWalletConnection } from "@/components/wallet-connection";
import { SpotSwapModal } from "@/components/stocks/spot-swap-modal";
import { homepageWallet, useHomepageWallet } from "./homepage-wallet";

/**
 * The homepage's wallet providers (Terms gate, transaction notices) and the Buy modal, in one tree. Loaded on first use
 * and kept mounted, so the connection stays for the rest of the visit and a purchase's notice outlives the modal.
 */
export function HomepageWalletRoot() {
  const { buy } = useHomepageWallet();
  return <Providers>
    <WalletBridge />
    <EvmBridge />
    {buy ? <SpotSwapModal key={buy.underlying} option={buy} onClose={homepageWallet.closeBuy} /> : null}
  </Providers>;
}

/** Reports the wallet to the store, and opens the wallet picker once per Connect wallet click. */
function WalletBridge() {
  const { address, connected, restoring, restoreStalled = false, connect, disconnect } = useWalletConnection();
  const { connectRequests } = useHomepageWallet();
  const current = connected && address ? address : null;
  // The provider's functions are new on every render: keep the latest in a ref instead of reporting them.
  const latestDisconnect = useRef(disconnect);
  useEffect(() => { latestDisconnect.current = disconnect; });
  useEffect(() => {
    homepageWallet.setDisconnect(() => latestDisconnect.current());
    return () => homepageWallet.unmounted();
  }, []);
  useEffect(() => { homepageWallet.report(current, restoring, restoreStalled); }, [current, restoring, restoreStalled]);
  // Answered once per click across roots (the store remembers), so coming back to the homepage replays nothing.
  useEffect(() => {
    if (!restoring && homepageWallet.takeConnectRequest() && !current) connect();
  }, [connectRequests, current, restoring, connect]);
  return null;
}

/** Reports the EVM wallet to the store, and starts an EVM connect once per EVM button click. */
function EvmBridge() {
  const evm = useOptionalEvmWalletConnection();
  const { evmConnectRequests } = useHomepageWallet();
  const latestDisconnect = useRef(evm?.disconnect);
  useEffect(() => { latestDisconnect.current = evm?.disconnect; });
  useEffect(() => {
    homepageWallet.setEvmDisconnect(() => latestDisconnect.current?.());
    return () => homepageWallet.setEvmDisconnect(null);
  }, []);
  useEffect(() => {
    if (!evm) return;
    homepageWallet.reportEvm(
      evm.wallet?.address ?? null,
      evm.status === "connecting" || evm.status === "restoring",
      evm.chainId ?? null,
      evm.error ?? null,
    );
  }, [evm, evm?.wallet?.address, evm?.status, evm?.chainId, evm?.error]);
  useEffect(() => {
    if (!evm) return;
    if (evm.status === "connecting" || evm.status === "restoring") return;
    if (homepageWallet.takeEvmConnectRequest() && !evm.wallet) {
      evm.dismissError();
      void evm.connect().catch(() => {});
    }
  }, [evm, evmConnectRequests, evm?.status, evm?.wallet]);
  return null;
}
