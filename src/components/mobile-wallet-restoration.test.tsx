// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWalletConnection, type WalletConnection } from "./wallet-connection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sdk = vi.hoisted(() => ({
  ready: Promise.resolve(),
  account: { address: undefined as string | undefined, isConnected: false, status: "disconnected" },
  open: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
}));
vi.mock("@reown/appkit/react", () => ({
  createAppKit: () => ({ ready: () => sdk.ready, open: sdk.open, disconnect: sdk.disconnect }),
  useAppKit: () => ({ open: async () => undefined }),
  useAppKitAccount: () => sdk.account,
  useAppKitProvider: () => ({ walletProvider: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
}));
vi.mock("@reown/appkit-adapter-solana/react", () => ({ SolanaAdapter: class {} }));
vi.mock("@reown/appkit/networks", () => ({ solana: { id: "solana:mainnet" } }));
vi.mock("./wallet-growth-analytics", () => ({ WalletGrowthAnalytics: () => null }));
vi.mock("./appkit-connect-analytics", () => ({ AppKitConnectAnalytics: () => null }));
vi.mock("./transactions/tx-notice-host", () => ({ TxNoticeHost: () => null }));

// Ensure the real provider constructs its AppKit instance in both env-matrix runs.
vi.stubEnv("NEXT_PUBLIC_REOWN_PROJECT_ID", "restoration-test");
const { MobileWalletProvider, WALLET_RESTORE_TIMEOUT_MS } = await import("./mobile-wallet-provider");
vi.unstubAllEnvs();

let root: Root;
let host: HTMLDivElement;
let connection: WalletConnection;
let resolveReady: () => void;
let rejectReady: (error: Error) => void;
function Reader() {
  const value = useWalletConnection();
  useEffect(() => { connection = value; }, [value]);
  return null;
}
const render = () => root.render(createElement(MobileWalletProvider, null, createElement(Reader)));

beforeEach(() => {
  sdk.ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  sdk.account = { address: undefined, isConnected: false, status: "disconnected" };
  sdk.open.mockClear(); sdk.disconnect.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("AppKit session restoration", () => {
  it("waits for SDK ready even if the initial account snapshot says disconnected", async () => {
    await act(async () => render());
    expect(connection.restoring).toBe(true);
    expect(connection.connected).toBe(false);
    sdk.account = { address: "restored-wallet", isConnected: true, status: "connected" };
    await act(async () => { resolveReady(); render(); });
    expect(connection.restoring).toBe(false);
    expect(connection.address).toBe("restored-wallet");
    expect(sdk.open).not.toHaveBeenCalled();
  });

  it.each(["connecting", "reconnecting"])("keeps a %s account pending after SDK initialization", async (status) => {
    sdk.account.status = status;
    await act(async () => { render(); resolveReady(); });
    expect(connection.restoring).toBe(true);
    sdk.account.status = "disconnected";
    await act(async () => render());
    expect(connection.restoring).toBe(false);
    expect(connection.connected).toBe(false);
  });

  it("releases a failed initialization so the visitor can explicitly retry", async () => {
    sdk.account.status = "connecting";
    await act(async () => render());
    await act(async () => rejectReady(new Error("initialization failed")));
    expect(connection.restoring).toBe(false);
    expect(connection.connectionError).toBe("Wallet restoration failed, please reconnect.");
    await act(async () => connection.connect());
    expect(sdk.open).toHaveBeenCalledExactlyOnceWith({ view: "Connect", namespace: "solana" });
  });
});

// A remembered wallet that never answers (locked extension, closed unlock popup) used to keep the button disabled forever.
describe("AppKit session restoration time limit", () => {
  const RESTORE_FAILED = "Wallet restoration failed, please reconnect.";
  const REMEMBERED = "@appkit/solana:connected_connector_id";
  const pastTimeLimit = () => act(async () => { vi.advanceTimersByTime(WALLET_RESTORE_TIMEOUT_MS); });
  let reload: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear(); sessionStorage.clear();
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const rememberWallet = () => {
    localStorage.setItem(REMEMBERED, "Phantom");
    localStorage.setItem("@appkit/connections", JSON.stringify({ solana: [{ connectorId: "Phantom", accounts: [{ address: "remembered" }] }] }));
  };
  const reloadPage = async () => {
    act(() => root.unmount());
    sdk.ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    sdk.account = { address: undefined, isConnected: false, status: "disconnected" };
    root = createRoot(host);
    await act(async () => render());
  };

  it("never settles: releases the button after the time limit, and a retry drops the stuck restore before the picker opens", async () => {
    rememberWallet();
    sdk.account.status = "connecting"; // AppKit keeps reporting the stuck restore
    await act(async () => render());
    await act(async () => { vi.advanceTimersByTime(WALLET_RESTORE_TIMEOUT_MS - 1); });
    expect(connection.restoring).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(connection.restoring).toBe(false);
    expect(connection.restoreStalled).toBe(true);
    expect(connection.connectionError).toBe(RESTORE_FAILED);

    await act(async () => connection.connect());
    // The stuck wallet is forgotten and the page reloads, so a late answer from it cannot replace the visitor's pick.
    expect(localStorage.getItem(REMEMBERED)).toBeNull();
    expect(JSON.parse(localStorage.getItem("@appkit/connections")!).solana).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sdk.open).not.toHaveBeenCalled();

    // After the reload nothing is left to restore: the picker opens once by itself, and only once.
    await reloadPage();
    expect(sdk.open).not.toHaveBeenCalled();
    await act(async () => resolveReady());
    expect(sdk.open).toHaveBeenCalledExactlyOnceWith({ view: "Connect", namespace: "solana" });
    expect(connection.restoring).toBe(false);
    expect(connection.connectionError).toBe("");
    await reloadPage();
    await act(async () => resolveReady());
    expect(sdk.open).toHaveBeenCalledTimes(1);
  });

  it("rejects: releases the button right away, and Connect opens the picker in place", async () => {
    rememberWallet();
    await act(async () => render());
    await act(async () => rejectReady(new Error("restore failed")));
    expect(connection.restoring).toBe(false);
    expect(connection.restoreStalled).toBe(true);
    expect(connection.connectionError).toBe(RESTORE_FAILED);
    await act(async () => connection.connect());
    expect(sdk.open).toHaveBeenCalledExactlyOnceWith({ view: "Connect", namespace: "solana" });
    expect(reload).not.toHaveBeenCalled();
    await pastTimeLimit();
    expect(connection.connectionError).toBe("");
    expect(connection.restoreStalled).toBe(false);
  });

  it("late success after the time limit connects normally, with no picker and no reload", async () => {
    rememberWallet();
    sdk.account.status = "connecting";
    await act(async () => render());
    await pastTimeLimit();
    expect(connection.restoreStalled).toBe(true);
    sdk.account = { address: "restored-wallet", isConnected: true, status: "connected" };
    await act(async () => { resolveReady(); render(); });
    expect(connection.connected).toBe(true);
    expect(connection.address).toBe("restored-wallet");
    expect(connection.restoring).toBe(false);
    expect(connection.restoreStalled).toBe(false);
    expect(connection.connectionError).toBe("");
    expect(sdk.open).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(localStorage.getItem(REMEMBERED)).toBe("Phantom");
  });

  it("empty storage: nothing to restore, no error and no retry prompt, before or after the time limit", async () => {
    await act(async () => { render(); resolveReady(); });
    expect(connection.restoring).toBe(false);
    await pastTimeLimit();
    expect(connection.restoring).toBe(false);
    expect(connection.restoreStalled).toBe(false);
    expect(connection.connectionError).toBe("");
    await act(async () => connection.connect());
    expect(sdk.open).toHaveBeenCalledExactlyOnceWith({ view: "Connect", namespace: "solana" });
    expect(reload).not.toHaveBeenCalled();
  });

  // AppKit 1.8.24 with a remembered WalletConnect wallet whose session is gone: ready() resolves, status stays "connecting".
  const rememberWalletConnect = () => {
    localStorage.setItem(REMEMBERED, "walletConnect");
    localStorage.setItem("@appkit/connections", JSON.stringify({ solana: [{ connectorId: "walletConnect", accounts: [{ address: "remembered" }] }] }));
  };

  it("ready resolves but the status stays connecting: released at the time limit, and a retry forgets the remembered wallet", async () => {
    rememberWalletConnect();
    sdk.account.status = "connecting";
    await act(async () => { render(); resolveReady(); });
    expect(connection.restoring).toBe(true);
    await act(async () => { vi.advanceTimersByTime(WALLET_RESTORE_TIMEOUT_MS - 1); });
    expect(connection.restoring).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(connection.restoring).toBe(false); // AppKit still says connecting; the button no longer listens
    expect(connection.restoreStalled).toBe(true);
    expect(connection.connectionError).toBe(RESTORE_FAILED);

    await act(async () => connection.connect());
    expect(localStorage.getItem(REMEMBERED)).toBeNull();
    expect(JSON.parse(localStorage.getItem("@appkit/connections")!).solana).toEqual([]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sdk.open).not.toHaveBeenCalled();

    await reloadPage();
    await act(async () => resolveReady());
    expect(sdk.open).toHaveBeenCalledExactlyOnceWith({ view: "Connect", namespace: "solana" });
    expect(connection.restoring).toBe(false);
  });

  it("a restore that reaches connected within the time limit is unaffected", async () => {
    rememberWallet();
    sdk.account.status = "connecting";
    await act(async () => { render(); resolveReady(); });
    expect(connection.restoring).toBe(true);
    await act(async () => { vi.advanceTimersByTime(3_000); });
    sdk.account = { address: "restored-wallet", isConnected: true, status: "connected" };
    await act(async () => render());
    expect(connection.connected).toBe(true);
    expect(connection.restoring).toBe(false);
    await pastTimeLimit();
    expect(connection.connected).toBe(true);
    expect(connection.restoreStalled).toBe(false);
    expect(connection.connectionError).toBe("");
    expect(reload).not.toHaveBeenCalled();
  });

  it("a successful WalletConnect restore is unaffected", async () => {
    rememberWalletConnect();
    sdk.account = { address: "wc-wallet", isConnected: true, status: "connected" };
    await act(async () => { render(); resolveReady(); });
    expect(connection.connected).toBe(true);
    expect(connection.restoring).toBe(false);
    await pastTimeLimit();
    expect(connection.connected).toBe(true);
    expect(connection.address).toBe("wc-wallet");
    expect(connection.restoreStalled).toBe(false);
    expect(connection.connectionError).toBe("");
    expect(localStorage.getItem(REMEMBERED)).toBe("walletConnect");
    expect(reload).not.toHaveBeenCalled();
  });

  it("a connect the visitor starts after a finished restore is not cut off by the time limit", async () => {
    await act(async () => { render(); resolveReady(); });
    expect(connection.restoring).toBe(false);
    sdk.account.status = "connecting"; // the visitor picked a wallet in the picker; it is still asking them
    await act(async () => render());
    await pastTimeLimit();
    expect(connection.restoreStalled).toBe(false);
    expect(connection.connectionError).toBe("");
    expect(reload).not.toHaveBeenCalled();
  });
});
