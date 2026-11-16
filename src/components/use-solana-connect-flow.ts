"use client";

import { useCallback, useState } from "react";
import { captureGrowthEvent } from "@/lib/analytics/client";
import { GROWTH_EVENTS } from "@/lib/analytics/events";
import { currentBrowseTarget } from "@/lib/analytics/wallet-connect";
import {
  captureWalletConnectAbandoned,
  captureWalletDeeplinkClicked,
  openWalletConnectSession,
} from "@/lib/analytics/wallet-connect-session";

/** Opens the existing wallet modal, or the mobile no-wallet deeplink sheet. */
export function useSolanaConnectFlow(openModal: () => void) {
  const [sheetOpen, setSheetOpen] = useState(false);

  const connect = useCallback(() => {
    captureGrowthEvent(GROWTH_EVENTS.walletConnectClicked);
    const context = openWalletConnectSession({ chain: "solana" });
    if (context.device === "mobile" && !context.wallet_extension_detected) {
      setSheetOpen(true);
      return;
    }
    openModal();
  }, [openModal]);

  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    captureWalletConnectAbandoned();
  }, []);

  const openWallet = useCallback((wallet: "Phantom" | "Solflare") => {
    captureWalletDeeplinkClicked(wallet, { chain: "solana" });
  }, []);

  /** Continue the same attempt in the existing picker; do not mark the sheet close as abandoned. */
  const chooseWalletHere = useCallback(() => {
    setSheetOpen(false);
    openModal();
  }, [openModal]);

  const target = currentBrowseTarget();
  return {
    connect,
    sheetOpen,
    closeSheet,
    openWallet,
    chooseWalletHere,
    pageUrl: target?.pageUrl ?? "",
    origin: target?.origin ?? "",
  };
}
