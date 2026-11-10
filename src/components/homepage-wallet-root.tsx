"use client";

import { useEffect, useRef } from "react";
import { Providers } from "@/components/providers";
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
    {buy ? <SpotSwapModal key={buy.underlying} option={buy} onClose={homepageWallet.closeBuy} /> : null}
  </Providers>;
}

/** Reports the wallet to the store, and opens the wallet picker once per Connect wallet click. */
function WalletBridge() {
  const { address, connected, connect, disconnect } = useWalletConnection();
  const { connectRequests } = useHomepageWallet();
  const current = connected && address ? address : null;
  // The provider's functions are new on every render: keep the latest in a ref instead of reporting them.
  const latestDisconnect = useRef(disconnect);
  useEffect(() => { latestDisconnect.current = disconnect; });
  useEffect(() => {
    homepageWallet.setDisconnect(() => latestDisconnect.current());
    return () => homepageWallet.unmounted();
  }, []);
  useEffect(() => { homepageWallet.report(current); }, [current]);
  // Answered once per click across roots (the store remembers), so coming back to the homepage replays nothing.
  useEffect(() => {
    if (homepageWallet.takeConnectRequest() && !current) connect();
  }, [connectRequests, current, connect]);
  return null;
}
