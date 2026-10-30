import {
  connectEvmWallet, currentChainId, discoverEvmWallets, type DiscoveredWallet, type Eip1193Provider, ensureRobinhoodChain, WalletRequestError,
} from "./eip1193";

/**
 * App-wide EVM wallet session (the nav "EVM wallet" button, the Robinhood Chain open dialog and My positions). Fully
 * independent of the Solana wallet adapter: nothing here reads or writes Solana state.
 * - `connect()`: discovery (MetaMask first) → `eth_requestAccounts` → `ensureRobinhoodChain`. Concurrent calls share one prompt.
 * - `restore()`: the account the wallet already shares with this site (`eth_accounts`, never a prompt or a chain switch),
 *   skipped after the user pressed Disconnect here.
 * - `disconnect()`: clears only SoFinance's own state (and remembers the choice); the wallet's site permission is untouched.
 * - Wallet events: `accountsChanged` (new account → new wallet object, [] → cleared), `chainChanged` (chain hint only),
 *   `disconnect` (cleared).
 * Signing is not here: every signing request still goes through `guardedWalletRequest`.
 */

export type EvmWallet = { provider: Eip1193Provider; address: `0x${string}`; name: string };
export type EvmSessionStatus = "idle" | "restoring" | "connecting" | "connected";
export type EvmSessionState = Readonly<{ status: EvmSessionStatus; wallet: EvmWallet | null; chainId: number | null; error: string | null }>;

export const EVM_SESSION_STORAGE_KEY = "sofi:evm-wallet:v1";

type Stored = { disconnected?: boolean; rdns?: string };
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type EvmSessionDeps = {
  discover?: () => Promise<DiscoveredWallet[]>;
  storage?: () => StorageLike | null;
};

const ACCOUNT = /^0x[0-9a-fA-F]{40}$/;
const IDLE: EvmSessionState = Object.freeze({ status: "idle", wallet: null, chainId: null, error: null });
const defaultStorage = () => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };

export type EvmSession = ReturnType<typeof createEvmSession>;

export function createEvmSession({ discover = () => discoverEvmWallets(), storage = defaultStorage }: EvmSessionDeps = {}) {
  let state: EvmSessionState = IDLE;
  let generation = 0;
  let pending: Promise<EvmWallet> | null = null;
  let detach: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const set = (next: Partial<EvmSessionState>) => { state = Object.freeze({ ...state, ...next }); listeners.forEach(l => l()); };
  const read = (): Stored => { try { return JSON.parse(storage()?.getItem(EVM_SESSION_STORAGE_KEY) ?? "{}") as Stored ?? {}; } catch { return {}; } };
  const write = (value: Stored) => { try { storage()?.setItem(EVM_SESSION_STORAGE_KEY, JSON.stringify(value)); } catch { /* storage unavailable: session still works */ } };

  const clear = () => { detach?.(); detach = null; generation += 1; pending = null; set({ ...IDLE }); };

  const attach = (wallet: EvmWallet) => {
    detach?.();
    const { provider } = wallet;
    const onAccounts = (accounts: unknown) => {
      if (state.wallet?.provider !== provider) return;
      const next = Array.isArray(accounts) ? accounts[0] : undefined;
      if (typeof next !== "string" || !ACCOUNT.test(next)) { clear(); return; }
      if (next.toLowerCase() === state.wallet.address.toLowerCase()) return;
      // A new object on purpose: everything keyed on the wallet (previews, open attempts) resets for the new account.
      set({ wallet: { ...state.wallet, address: next as `0x${string}` } });
    };
    const onChain = (id: unknown) => {
      if (state.wallet?.provider !== provider) return;
      const parsed = typeof id === "string" ? Number.parseInt(id, 16) : typeof id === "number" ? id : NaN;
      set({ chainId: Number.isFinite(parsed) ? parsed : null });
    };
    const onDisconnect = () => { if (state.wallet?.provider === provider) clear(); };
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    provider.on?.("disconnect", onDisconnect);
    detach = () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  };

  const adopt = (found: DiscoveredWallet, address: `0x${string}`, chainId: number | null) => {
    const wallet: EvmWallet = { provider: found.provider, address, name: found.info.name };
    attach(wallet);
    set({ status: "connected", wallet, chainId, error: null });
    return wallet;
  };

  const connect = (): Promise<EvmWallet> => {
    if (pending) return pending;
    const ticket = ++generation;
    const previous = state;
    set({ status: "connecting", error: null });
    const run = (async () => {
      await null; // `pending` is set before any wallet call can settle.
      try {
        const [first] = await discover();
        if (!first) throw new WalletRequestError("no-account", "No EVM wallet found. Install MetaMask to continue.");
        const address = await connectEvmWallet(first.provider);
        await ensureRobinhoodChain(first.provider);
        const chainId = await currentChainId(first.provider);
        if (ticket !== generation) throw new WalletRequestError("unknown", "Wallet connection was cancelled");
        write({ rdns: first.info.rdns });
        return adopt(first, address, chainId);
      } catch (error) {
        if (ticket === generation) {
          const message = error instanceof Error ? error.message : "Wallet connection failed";
          set(previous.wallet ? { ...previous, error: message } : { ...IDLE, error: message });
        }
        throw error;
      } finally {
        if (ticket === generation) pending = null;
      }
    })();
    pending = run;
    return run;
  };

  const restore = async (): Promise<void> => {
    if (state.wallet || pending || read().disconnected) return;
    const ticket = ++generation;
    set({ status: "restoring" });
    try {
      const wallets = await discover();
      const { rdns } = read();
      const found = wallets.find(w => rdns && w.info.rdns === rdns) ?? wallets[0];
      const accounts = found ? await found.provider.request({ method: "eth_accounts" }).catch(() => null) : null;
      const account = Array.isArray(accounts) ? accounts[0] : null;
      if (ticket !== generation) return;
      if (!found || typeof account !== "string" || !ACCOUNT.test(account)) { set({ ...IDLE }); return; }
      adopt(found, account as `0x${string}`, await currentChainId(found.provider));
    } catch {
      if (ticket === generation) set({ ...IDLE });
    }
  };

  const disconnect = () => { clear(); write({ ...read(), disconnected: true }); };
  const dismissError = () => { if (state.error) set({ error: null }); };

  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect, restore, disconnect, dismissError,
  };
}
