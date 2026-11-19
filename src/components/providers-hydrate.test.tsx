// @vitest-environment happy-dom
import { act, createElement, useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "./providers";
import type { WalletConnection } from "./wallet-connection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounts = vi.hoisted(() => ({ termsGate: 0, child: 0 }));

const dynamicLoad = vi.hoisted(() => {
  let component: ComponentType<{ onChange: (value: WalletConnection) => void }> | null = null;
  let loader: (() => Promise<unknown>) | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { listeners.forEach((listener) => listener()); };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    get: () => component,
    setLoader: (fn: () => Promise<unknown>) => { loader = fn; },
    async finish() {
      if (!loader) throw new Error("dynamic loader was not captured");
      const loaded = await loader();
      component = typeof loaded === "function"
        ? loaded as ComponentType<{ onChange: (value: WalletConnection) => void }>
        : (loaded as { default: ComponentType<{ onChange: (value: WalletConnection) => void }> }).default;
      emit();
    },
    reset() {
      component = null;
      emit();
    },
  };
});

vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<unknown>) => {
    dynamicLoad.setLoader(loader);
    return function DynamicPending(props: { onChange: (value: WalletConnection) => void }) {
      const Comp = useSyncExternalStore(dynamicLoad.subscribe, dynamicLoad.get, () => null);
      return Comp ? createElement(Comp, props) : null;
    };
  },
}));

vi.mock("@/lib/engine-host", () => ({}));
vi.mock("@solana/wallet-adapter-react", () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => children,
  WalletProvider: ({ children }: { children: ReactNode }) => children,
  useConnection: () => ({ connection: {} }),
  useWallet: () => ({
    publicKey: undefined, connected: false, connecting: false, disconnect: vi.fn(), wallets: [],
    signTransaction: undefined, sendTransaction: undefined, wallet: undefined,
  }),
}));
vi.mock("@solana/wallet-adapter-react-ui", () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => children,
  useWalletModal: () => ({ setVisible: vi.fn(), visible: false }),
}));
vi.mock("./evm-wallet-connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./evm-wallet-connection")>();
  return {
    ...actual,
    EvmWalletProvider: ({ children }: { children: ReactNode }) => children,
    useOptionalEvmWalletConnection: () => null,
  };
});
vi.mock("./terms-gate", async (importOriginal) => {
  const { TermsGate: Real } = await importOriginal<typeof import("./terms-gate")>();
  return {
    TermsGate: function TermsGate(props: { children: ReactNode }) {
      useEffect(() => { mounts.termsGate += 1; }, []);
      return createElement(Real, props);
    },
  };
});
vi.mock("./mobile-wallet-provider", () => ({
  MobileWalletBridge: function MobileWalletBridge({ onChange }: { onChange: (value: WalletConnection) => void }) {
    useEffect(() => {
      onChange({
        connected: false,
        restoring: false,
        connect: () => {},
        disconnect: () => {},
        isMobile: true,
        walletsCount: 1,
        connectionError: "",
        signTransaction: async () => { throw new Error("Wallet is not connected"); },
      });
    }, [onChange]);
    return createElement("div", { "data-testid": "appkit-bridge" }, "appkit-ready");
  },
}));

describe("Providers Reown hydrate", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    mounts.termsGate = 0;
    mounts.child = 0;
    dynamicLoad.reset();
    vi.stubEnv("NEXT_PUBLIC_REOWN_PROJECT_ID", "test-reown-id");
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    act(() => { root?.unmount(); });
    container.remove();
    vi.unstubAllEnvs();
  });

  function Child() {
    useEffect(() => { mounts.child += 1; }, []);
    return createElement("main", { "data-testid": "ssr-child" }, "Same-stock liquidity pools");
  }

  function tree() {
    return createElement(Providers, null, createElement(Child));
  }

  it("hydrates without remounting children or TermsGate, and never blanks the container while AppKit loads", async () => {
    container.innerHTML = renderToString(tree());
    expect(container.querySelector("[data-testid=ssr-child]")).not.toBeNull();
    expect(container.textContent).toContain("Same-stock liquidity pools");

    let sawEmpty = false;
    const record = () => {
      if (!container.querySelector("[data-testid=ssr-child]")) sawEmpty = true;
      if (!container.textContent?.includes("Same-stock liquidity pools")) sawEmpty = true;
    };
    const observer = new MutationObserver(record);
    observer.observe(container, { childList: true, subtree: true, characterData: true });

    await act(async () => {
      root = hydrateRoot(container, tree());
    });
    record();
    expect(container.querySelector("[data-testid=appkit-bridge]")).toBeNull();

    await act(async () => { await dynamicLoad.finish(); });
    record();
    observer.disconnect();

    expect(sawEmpty).toBe(false);
    expect(container.querySelector("[data-testid=ssr-child]")).not.toBeNull();
    expect(container.querySelector("[data-testid=appkit-bridge]")).not.toBeNull();
    expect(mounts.child).toBe(1);
    expect(mounts.termsGate).toBe(1);
  });
});
