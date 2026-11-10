"use client";

/**
 * The homepage's one wallet, shared by the header's Connect wallet and the stock rows' Buy. The wallet providers are
 * heavy, so they load only on first use (`HomepageWalletRoot`, mounted once by `HomepageWalletIsland`); this small store
 * is what the light parts of the page talk to. One providers tree means connecting in the header is the connection Buy
 * uses, and the other way round.
 */
import { useSyncExternalStore } from "react";
import type { StockBuyOption } from "@/lib/stock-market/public";

export type HomepageWalletState = {
  /** The providers are (being) loaded. Set by the first Connect wallet or Buy, or on load for a remembered wallet. */
  mounted: boolean;
  /** The providers have loaded and report the wallet below. */
  ready: boolean;
  /** Bumped by every Connect wallet click; the root opens the wallet picker once per bump. */
  connectRequests: number;
  /** The connected Solana wallet, or null. */
  address: string | null;
  /** The stock whose Buy modal is open. */
  buy: StockBuyOption | null;
};

const INITIAL: HomepageWalletState = { mounted: false, ready: false, connectRequests: 0, address: null, buy: null };
let state = INITIAL;
const listeners = new Set<() => void>();
/**
 * The root's disconnect, kept outside the state: the wallet provider hands out a new function on every render, and
 * putting it in the state would re-render the root, which re-renders the provider, which hands out a new one (a loop).
 */
let disconnectWallet: (() => void) | null = null;

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
  /** Called by the root: the providers are up, with this wallet (or none). */
  report: (address: string | null) => set({ ready: true, address }),
  /** Called by the root: how to disconnect (not part of the state, see `disconnectWallet`). */
  setDisconnect: (disconnect: (() => void) | null) => { disconnectWallet = disconnect; },
  /** The root unmounted (the visitor left the homepage): nothing it reported is true any more. */
  unmounted: () => { disconnectWallet = null; set({ ready: false, address: null, buy: null }); },
  /** Tests only. */
  reset: () => { state = INITIAL; disconnectWallet = null; for (const listener of listeners) listener(); },
};

export function useHomepageWallet(): HomepageWalletState {
  return useSyncExternalStore(homepageWallet.subscribe, homepageWallet.get, () => INITIAL);
}

/** `@solana/wallet-adapter-react` keeps the last wallet's name here and reconnects it (`autoConnect`). */
export const REMEMBERED_WALLET_KEY = "walletName";
