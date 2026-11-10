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
  /** Disconnects the wallet (set by the root once loaded). */
  disconnect: (() => void) | null;
};

const INITIAL: HomepageWalletState = { mounted: false, ready: false, connectRequests: 0, address: null, buy: null, disconnect: null };
let state = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<HomepageWalletState>) {
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
  /** Called by the root: the providers are up, with this wallet (or none). */
  report: (address: string | null, disconnect: () => void) => set({ ready: true, address, disconnect }),
  /** Tests only. */
  reset: () => { state = INITIAL; for (const listener of listeners) listener(); },
};

export function useHomepageWallet(): HomepageWalletState {
  return useSyncExternalStore(homepageWallet.subscribe, homepageWallet.get, () => INITIAL);
}

/** `@solana/wallet-adapter-react` keeps the last wallet's name here and reconnects it (`autoConnect`). */
export const REMEMBERED_WALLET_KEY = "walletName";
