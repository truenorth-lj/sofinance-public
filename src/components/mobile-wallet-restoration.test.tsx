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
const { MobileWalletProvider } = await import("./mobile-wallet-provider");
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
afterEach(() => { act(() => root.unmount()); host.remove(); });

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
