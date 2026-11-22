"use client";

/**
 * The site header's wallet island (marketing pages and public `/pools/[slug]` pages) plus the homepage Buy modal.
 * Wallet providers are heavy, so they load only on first use (`HomepageWalletRoot`, mounted once by
 * `HomepageWalletIsland`); this small store is what the light header talks to. Anonymous visits never mount the
 * providers, so they make no RPC or paid wallet-cloud calls. One providers tree means connecting in the header is
 * the connection Buy uses, and the other way round.
 */
import { useSyncExternalStore } from "react";
import type { StockBuyOption } from "@/lib/stock-market/public";
import { APPKIT_CONNECTIONS, APPKIT_SOLANA_CONNECTOR } from "@/lib/wallet-restore";

export type HomepageWalletState = {
  /** The providers are (being) loaded. Set by the first Connect wallet or Buy, or on load for a remembered wallet. */
  mounted: boolean;
  /** The providers have finished restoring their session and report the wallet below. */
  ready: boolean;
  /** Bumped by every Connect wallet click; the root opens the wallet picker once per bump. */
  connectRequests: number;
  /** The connected Solana wallet, or null. */
  address: string | null;
  /** Restoring the remembered Solana wallet failed or timed out; the header offers a retry. */
  restoreStalled: boolean;
  /** The stock whose Buy modal is open. */
  buy: StockBuyOption | null;
  /** Bumped by every EVM connect click; the root opens the EVM flow once per bump. */
  evmConnectRequests: number;
  /** The connected EVM wallet address, or null. */
  evmAddress: string | null;
  /** The EVM session has finished restoring and reports evmAddress. */
  evmReady: boolean;
  evmChainId: number | null;
  evmError: string | null;
};

const INITIAL: HomepageWalletState = { mounted: false, ready: false, connectRequests: 0, address: null, restoreStalled: false, buy: null, evmConnectRequests: 0, evmAddress: null, evmReady: false, evmChainId: null, evmError: null };
let state = INITIAL;
const listeners = new Set<() => void>();
/**
 * The root's disconnect, kept outside the state: the wallet provider hands out a new function on every render, and
 * putting it in the state would re-render the root, which re-renders the provider, which hands out a new one (a loop).
 */
let disconnectWallet: (() => void) | null = null;
/**
 * How many Connect wallet clicks a root has answered. Kept here, not in the root, because the store outlives the root:
 * a root mounted again after the visitor comes back to the homepage must not answer an old click (the picker would open
 * by itself).
 */
let answeredConnectRequests = 0;
let disconnectEvmWallet: (() => void) | null = null;
let answeredEvmConnectRequests = 0;

/** Notifies only when a value really changed, so a report of the same wallet re-renders nothing. */
function set(patch: Partial<HomepageWalletState>) {
  if ((Object.keys(patch) as (keyof HomepageWalletState)[]).every((key) => Object.is(state[key], patch[key]))) return;
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export const homepageWallet = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** Load the providers without asking for anything (a wallet remembered from an earlier visit reconnects itself). */
  mount: () => { if (!state.mounted) set({ mounted: true }); },
  requestConnect: () => set({ mounted: true, connectRequests: state.connectRequests + 1 }),
  openBuy: (option: StockBuyOption) => set({ mounted: true, buy: option }),
  closeBuy: () => set({ buy: null }),
  disconnect: () => disconnectWallet?.(),
  /** True once for each Connect wallet click no root has answered yet (the caller then opens the picker). */
  takeConnectRequest: () => {
    if (state.connectRequests <= answeredConnectRequests) return false;
    answeredConnectRequests = state.connectRequests;
    return true;
  },
  /** Called by the root; mounting a provider alone does not finish its async session restoration. */
  report: (address: string | null, restoring = false, restoreStalled = false) => set({ ready: !restoring, address, restoreStalled }),
  /** Called by the root: how to disconnect (not part of the state, see `disconnectWallet`). */
  setDisconnect: (disconnect: (() => void) | null) => { disconnectWallet = disconnect; },
  requestEvmConnect: () => set({ mounted: true, evmConnectRequests: state.evmConnectRequests + 1 }),
  takeEvmConnectRequest: () => {
    if (state.evmConnectRequests <= answeredEvmConnectRequests) return false;
    answeredEvmConnectRequests = state.evmConnectRequests;
    return true;
  },
  reportEvm: (address: string | null, restoring = false, chainId: number | null = null, error: string | null = null) =>
    set({ evmReady: !restoring, evmAddress: address, evmChainId: chainId, evmError: error }),
  setEvmDisconnect: (disconnect: (() => void) | null) => { disconnectEvmWallet = disconnect; },
  disconnectEvm: () => disconnectEvmWallet?.(),
  dismissEvmError: () => { if (state.evmError !== null) set({ evmError: null }); },
  /** The root unmounted (the visitor left the page): nothing it reported is true any more. */
  unmounted: () => {
    disconnectWallet = null;
    disconnectEvmWallet = null;
    set({ ready: false, address: null, restoreStalled: false, buy: null, evmReady: false, evmAddress: null, evmChainId: null, evmError: null });
  },
  /** Tests only. */
  reset: () => {
    state = INITIAL;
    disconnectWallet = null;
    disconnectEvmWallet = null;
    answeredConnectRequests = 0;
    answeredEvmConnectRequests = 0;
    for (const listener of listeners) listener();
  },
};

export function useHomepageWallet(): HomepageWalletState {
  return useSyncExternalStore(homepageWallet.subscribe, homepageWallet.get, () => INITIAL);
}

/** `@solana/wallet-adapter-react` keeps the last wallet's name here and reconnects it (`autoConnect`). */
export const REMEMBERED_WALLET_KEY = "walletName";

/** Storage is only a loading hint. The provider must confirm the connection before we display a wallet. */
export function hasRememberedHomepageWallet(): boolean {
  try {
    const storage = window.localStorage;
    const legacy = storage.getItem(REMEMBERED_WALLET_KEY);
    if ((legacy && legacy !== "null") || storage.getItem(APPKIT_SOLANA_CONNECTOR)) return true;
    // AppKit can also restore a connection when only its connection list remains.
    const connections = JSON.parse(storage.getItem(APPKIT_CONNECTIONS) || "null");
    return Array.isArray(connections?.solana) && connections.solana.length > 0;
  } catch {
    return false;
  }
}
