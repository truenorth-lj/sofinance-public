"use client";

import { useEffect, useRef } from "react";
import { useAppKitEvents, useAppKitState } from "@reown/appkit/react";
import {
  captureWalletConnectAbandoned,
  captureWalletConnectFailed,
  captureWalletConnectStarted,
  noteWalletConnectSucceeded,
} from "@/lib/analytics/wallet-connect-session";

function eventName(data: { properties?: { name?: unknown } }, fallback?: string): string | undefined {
  const name = data.properties?.name;
  if (typeof name === "string" && name) return name;
  return fallback || undefined;
}

function eventMessage(data: { properties?: { message?: unknown } }, fallback: string): string {
  const message = data.properties?.message;
  return typeof message === "string" && message ? message : fallback;
}

/** Translates AppKit connect-modal events into our PostHog connect funnel. */
export function AppKitConnectAnalytics() {
  const events = useAppKitEvents();
  const { connectingWallet } = useAppKitState();
  const seenTs = useRef<number | null>(null);

  useEffect(() => {
    // Skip the historical event already sitting on the controller when this listener mounts.
    if (seenTs.current === null) {
      seenTs.current = events.timestamp;
      return;
    }
    if (events.timestamp === seenTs.current) return;
    seenTs.current = events.timestamp;
    const data = events.data as { event?: string; properties?: { name?: unknown; message?: unknown; connected?: unknown } };
    const event = data?.event;
    const walletName = eventName(data, connectingWallet?.name);
    const extra = { wallet_name: walletName, chain: "solana" as const };
    if (event === "SELECT_WALLET" && walletName) {
      captureWalletConnectStarted({ ...extra, wallet_name: walletName });
    } else if (event === "USER_REJECTED") {
      captureWalletConnectFailed(Object.assign(new Error(eventMessage(data, "User rejected the request.")), { code: 4001 }), extra);
    } else if (event === "CONNECT_ERROR") {
      captureWalletConnectFailed(new Error(eventMessage(data, "Wallet connection failed")), extra);
    } else if (event === "CONNECT_SUCCESS") {
      noteWalletConnectSucceeded();
    } else if (event === "MODAL_CLOSE") {
      if (data.properties?.connected) noteWalletConnectSucceeded();
      else captureWalletConnectAbandoned();
    }
  }, [events.timestamp, events.data, connectingWallet?.name]);

  return null;
}
