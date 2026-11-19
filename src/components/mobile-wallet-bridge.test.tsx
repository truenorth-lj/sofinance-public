// @vitest-environment happy-dom
import { act, createElement, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletConnection } from "./wallet-connection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sdk = vi.hoisted(() => ({
  ready: Promise.resolve(),
  account: { address: undefined as string | undefined, isConnected: false, status: "disconnected" },
  walletProvider: undefined as unknown,
  open: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
}));

vi.mock("@reown/appkit/react", () => ({
  createAppKit: () => ({
    ready: () => sdk.ready,
    open: sdk.open,
    disconnect: sdk.disconnect,
  }),
  // New function identities on every render, as AppKit 1.8.24 actually does.
  useAppKit: () => ({ open: async () => undefined }),
  useDisconnect: () => ({ disconnect: async () => undefined }),
  useAppKitAccount: () => ({ ...sdk.account }),
  useAppKitProvider: () => ({ walletProvider: sdk.walletProvider }),
  useAppKitEvents: () => ({ timestamp: 0, data: { event: "MODAL_CREATED" } }),
  useAppKitState: () => ({ open: false, initialized: true, loading: false, connectingWallet: undefined }),
}));
vi.mock("@reown/appkit-adapter-solana/react", () => ({ SolanaAdapter: class {} }));
vi.mock("@reown/appkit/networks", () => ({ solana: { id: "solana:mainnet" } }));
vi.mock("./wallet-growth-analytics", () => ({ WalletGrowthAnalytics: () => null }));
vi.mock("./appkit-connect-analytics", () => ({ AppKitConnectAnalytics: () => null }));
vi.mock("./transactions/tx-notice-host", () => ({ TxNoticeHost: () => null }));

vi.stubEnv("NEXT_PUBLIC_REOWN_PROJECT_ID", "bridge-loop-test");
const { MobileWalletBridge } = await import("./mobile-wallet-provider");
vi.unstubAllEnvs();

const ADDRESS = "EweTgJ6vaQDZyH5nk5uaK5iD7n1qr7BXTaxewcjQNEjb";

describe("MobileWalletBridge onChange", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onChange: ReturnType<typeof vi.fn<(value: WalletConnection) => void>>;

  function Parent() {
    const [, setValue] = useState<WalletConnection | null>(null);
    const handleChange = useCallback((value: WalletConnection) => {
      onChange(value);
      setValue(value);
    }, []);
    return createElement(MobileWalletBridge, { onChange: handleChange });
  }

  const render = () => root.render(createElement(Parent));
  const last = () => {
    const value = onChange.mock.calls.at(-1)?.[0];
    if (!value) throw new Error("onChange was not called");
    return value;
  };

  beforeEach(() => {
    sdk.ready = Promise.resolve();
    sdk.account = { address: undefined, isConnected: false, status: "disconnected" };
    sdk.walletProvider = undefined;
    sdk.open.mockClear();
    sdk.disconnect.mockClear();
    onChange = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("settles without a render loop even when AppKit hooks return new open/disconnect functions each render", async () => {
    await act(async () => render());
    expect(onChange.mock.calls.length).toBeGreaterThan(0);
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(3);
    const afterSettle = onChange.mock.calls.length;
    await act(async () => render());
    expect(onChange.mock.calls.length).toBe(afterSettle);
  });

  it("updates the value when the AppKit account address changes", async () => {
    await act(async () => render());
    expect(last().connected).toBe(false);
    const before = onChange.mock.calls.length;
    sdk.account = { address: ADDRESS, isConnected: true, status: "connected" };
    await act(async () => render());
    expect(onChange.mock.calls.length).toBeGreaterThan(before);
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(before + 3);
    expect(last().address).toBe(ADDRESS);
    expect(last().connected).toBe(true);
    expect(last().restoring).toBe(false);
  });

  it("updates the value on disconnect and calls the module-level AppKit disconnect", async () => {
    sdk.account = { address: ADDRESS, isConnected: true, status: "connected" };
    await act(async () => render());
    expect(last().connected).toBe(true);
    const before = onChange.mock.calls.length;
    await act(async () => { last().disconnect(); });
    expect(sdk.disconnect).toHaveBeenCalledExactlyOnceWith("solana");
    sdk.account = { address: undefined, isConnected: false, status: "disconnected" };
    await act(async () => render());
    expect(onChange.mock.calls.length).toBeGreaterThan(before);
    expect(last().address).toBeUndefined();
    expect(last().connected).toBe(false);
  });
});
