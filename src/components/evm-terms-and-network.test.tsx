// @vitest-environment happy-dom
// EVM wallet: the connect goes through the same "Before you connect" terms step as Solana (same text, same acceptance
// storage), and a wallet on the wrong network gets a "Wrong network" switch in the nav and a switch prompt in the
// Robinhood Chain sections (My positions block, Open position dialog).
import { act, createElement, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
const panels = vi.hoisted(() => ({ open: vi.fn(), positions: vi.fn() }));
vi.mock("./rhc-univ4-open-panel", () => ({ RhcUniv4OpenPanel: (props: unknown) => { panels.open(props); return createElement("div", { "data-testid": "rhc-open-panel" }); } }));
vi.mock("./rhc-univ4-positions-panel", () => ({ RhcUniv4PositionsPanel: (props: unknown) => { panels.positions(props); return createElement("div", { "data-testid": "rhc-positions-panel" }); } }));

import { InkNav } from "./ink/InkNav";
import { TermsGate } from "./terms-gate";
import { EvmWalletProvider, useEvmWalletConnection, type EvmWalletConnection } from "./evm-wallet-connection";
import { useWalletConnection, WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import { RhcOpenDialog } from "./unified-pools/rhc-open-dialog";
import { RhcPositionsSection } from "./unified-pools/rhc-positions-section";
import { createEvmSession, type EvmSession } from "@/lib/rhc-wallet/evm-session";
import type { Eip1193Provider } from "@/lib/rhc-wallet/eip1193";
import { recordTermsAcceptance, TERMS_ATTESTATION, TERMS_STORAGE_KEY } from "@/lib/terms-acceptance";

const EVM = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04";
const POOL = { poolId: "0xpool" } as never;

// A mock MetaMask: chain state, events, configurable switch behaviour. Signing methods are never answered.
const wallet = { chain: "0x1237", shared: false, switchError: null as null | { code: number }, calls: [] as string[] };
const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
const emit = (event: string, ...args: unknown[]) => handlers.get(event)?.forEach(l => l(...args));
const provider: Eip1193Provider = {
  request: async ({ method }) => {
    wallet.calls.push(method);
    if (method === "eth_requestAccounts") { wallet.shared = true; return [EVM]; }
    if (method === "eth_accounts") return wallet.shared ? [EVM] : [];
    if (method === "eth_chainId") return wallet.chain;
    if (method === "wallet_switchEthereumChain") {
      if (wallet.switchError) throw wallet.switchError;
      wallet.chain = "0x1237"; emit("chainChanged", "0x1237"); return null;
    }
    if (method === "wallet_addEthereumChain") { wallet.switchError = null; wallet.chain = "0x1237"; emit("chainChanged", "0x1237"); return null; }
    throw new Error(`unexpected ${method}`);
  },
  on: (e, l) => { (handlers.get(e) ?? handlers.set(e, new Set()).get(e)!).add(l); },
  removeListener: (e, l) => { handlers.get(e)?.delete(l); },
};
const discover = async () => [{ info: { uuid: "mm", name: "MetaMask", rdns: "io.metamask" }, provider }];

let container: HTMLDivElement; let root: Root; let session: EvmSession; let solana: WalletConnection;
const live = {} as { evm: EvmWalletConnection };
function Reader() { const value = useEvmWalletConnection(); useEffect(() => { live.evm = value; }); return null; }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); handlers.clear(); panels.open.mockClear(); panels.positions.mockClear();
  Object.assign(wallet, { chain: "0x1237", shared: false, switchError: null, calls: [] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  session = createEvmSession({ discover, storage: () => localStorage });
  solana = { connected: false, connect: vi.fn(), disconnect: vi.fn(), isMobile: false, walletsCount: 1, connectionError: "", signTransaction: vi.fn() };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise(r => setTimeout(r, 0)); });
async function render(children: ReactNode) {
  await act(async () => {
    root.render(createElement(EvmWalletProvider, { enabled: true, session },
      createElement(WalletConnectionContext.Provider, { value: solana }, createElement(TermsGate, null, createElement(Reader), children))));
  });
  await flush();
}
// Like the app's pages: the nav's Solana handlers come from the (terms-gated) Solana wallet context.
function NavHost() { const s = useWalletConnection(); return createElement(InkNav, { wallet: null, connected: s.connected, onConnect: s.connect, onDisconnect: s.disconnect }); }
const nav = () => createElement(NavHost);
const q = (selector: string) => container.querySelector<HTMLElement>(selector);
const terms = () => container.querySelector<HTMLElement>("[role=dialog][aria-labelledby=terms-gate-title]");
const click = async (el: HTMLElement | null) => { await act(async () => { el!.click(); }); await flush(); };
const termsButton = (label: string) => [...terms()!.querySelectorAll("button")].find(b => b.textContent === label)!;
const acceptTerms = async () => {
  await act(async () => { terms()!.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(); });
  await click(termsButton("Continue to wallet"));
};
const noWalletPrompt = () => expect(wallet.calls).not.toContain("eth_requestAccounts");

describe("EVM connect goes through the terms step", () => {
  it("asks first in a browser that never accepted, with the same terms text, then connects once accepted", async () => {
    await render(nav());
    await click(q("[data-testid=nav-evm-wallet]"));
    expect(terms()).not.toBeNull();
    expect(terms()!.textContent).toContain("Before you connect");
    expect(terms()!.textContent).toContain(TERMS_ATTESTATION.replace(/Terms of Service$/, ""));
    expect(terms()!.querySelector("a")!.getAttribute("href")).toBe("/terms");
    noWalletPrompt();
    expect(termsButton("Continue to wallet").hasAttribute("disabled")).toBe(true);

    await acceptTerms();
    expect(terms()).toBeNull();
    expect(wallet.calls.filter(c => c === "eth_requestAccounts")).toHaveLength(1);
    expect(q("[data-testid=nav-evm-wallet]")!.dataset.connected).toBe("true");
    expect(localStorage.getItem(TERMS_STORAGE_KEY)).toContain("acceptedAt");
    expect(solana.connect).not.toHaveBeenCalled();                 // accepting for EVM never connects Solana
  });

  it("does not ask again once this browser accepted, whether through the Solana or the EVM flow", async () => {
    recordTermsAcceptance();                                        // the same storage the Solana flow writes
    await render(nav());
    await click(q("[data-testid=nav-evm-wallet]"));
    expect(terms()).toBeNull();
    expect(q("[data-testid=nav-evm-wallet]")!.dataset.connected).toBe("true");
  });

  it("accepting in the Solana flow covers the EVM connect too", async () => {
    await render(nav());
    await click(q("[data-testid=nav-solana-wallet]"));
    expect(terms()).not.toBeNull();
    await acceptTerms();
    expect(solana.connect).toHaveBeenCalledTimes(1);
    noWalletPrompt();                                               // the Solana acceptance did not connect EVM
    await click(q("[data-testid=nav-evm-wallet]"));
    expect(terms()).toBeNull();
    expect(q("[data-testid=nav-evm-wallet]")!.dataset.connected).toBe("true");
  });

  it("Cancel makes no wallet request and rejects the EVM connect", async () => {
    await render(null);
    let outcome: unknown;
    await act(async () => { live.evm.connect().then(() => { outcome = "connected"; }, (error: unknown) => { outcome = error; }); });
    await act(async () => { live.evm.connect().catch(() => {}); });   // a second caller shares the one terms step
    expect(container.querySelectorAll("[role=dialog]")).toHaveLength(1);
    await click(termsButton("Cancel"));
    expect(outcome).toMatchObject({ code: "rejected" });
    expect(terms()).toBeNull();
    noWalletPrompt();
    expect(localStorage.getItem(TERMS_STORAGE_KEY)).toBeNull();
  });

  it("asks an EVM wallet restored before acceptance, and Disconnect clears only the EVM wallet", async () => {
    wallet.shared = true;                                           // MetaMask already shares an account with the site
    await render(nav());
    expect(live.evm.wallet?.address).toBe(EVM);
    expect(terms()).not.toBeNull();
    await click(termsButton("Disconnect"));
    expect(live.evm.wallet).toBeNull();
    expect(solana.disconnect).not.toHaveBeenCalled();
  });

  it("the Robinhood Chain dialog's connect goes through the same step and updates the nav", async () => {
    await render(createElement("div", null, nav(), createElement(RhcOpenDialog, { pool: POOL, signingEnabled: false, onClose: () => {} })));
    const props = panels.open.mock.lastCall![0] as { connectWallet: () => Promise<unknown>; autoConnect: boolean };
    expect(props.autoConnect).toBe(true);
    let connected: unknown;
    await act(async () => { props.connectWallet().then(w => { connected = w; }); });
    await flush();
    expect(terms()).not.toBeNull();
    noWalletPrompt();
    await acceptTerms();
    expect(connected).toMatchObject({ address: EVM });
    expect(q("[data-testid=nav-evm-wallet]")!.dataset.connected).toBe("true");
    expect(panels.open).toHaveBeenLastCalledWith(expect.objectContaining({ initialWallet: live.evm.wallet }));
  });
});

describe("wrong network", () => {
  async function onOtherNetwork(children: ReactNode) {
    recordTermsAcceptance();
    wallet.shared = true; wallet.chain = "0x1";                     // restored on Ethereum mainnet
    await render(children);
    expect(live.evm.wrongNetwork).toBe(true);
  }

  it("the nav keeps the address and shows an amber Wrong network button instead of a chain tag; it switches to Robinhood Chain", async () => {
    await onOtherNetwork(nav());
    const switchButton = q("[data-testid=nav-evm-switch]")!;
    expect(switchButton.textContent).toBe("Wrong network");
    expect(q("[data-testid=nav-evm-wallet]")!.textContent).toBe("0xb95b…1b04");
    expect(q("[data-testid=nav-evm-group]")!.textContent).not.toMatch(/RHC|EVM$/);
    await click(switchButton);
    expect(wallet.calls).toContain("wallet_switchEthereumChain");
    expect(q("[data-testid=nav-evm-switch]")).toBeNull();
    expect(q("[data-testid=nav-evm-wallet]")!.textContent).toBe("0xb95b…1b04RHC");
    expect(live.evm.chainId).toBe(4663);
    noWalletPrompt();
  });

  it("adds Robinhood Chain when the wallet does not know it (4902), then it is on the right network", async () => {
    await onOtherNetwork(nav());
    wallet.switchError = { code: 4902 };
    await click(q("[data-testid=nav-evm-switch]"));
    expect(wallet.calls).toEqual(expect.arrayContaining(["wallet_switchEthereumChain", "wallet_addEthereumChain"]));
    expect(live.evm.wrongNetwork).toBe(false);
  });

  it("a rejected switch keeps the wallet connected on the wrong network and says why", async () => {
    await onOtherNetwork(nav());
    wallet.switchError = { code: 4001 };
    await click(q("[data-testid=nav-evm-switch]"));
    expect(live.evm.wallet?.address).toBe(EVM);
    expect(q("[data-testid=nav-evm-switch]")).not.toBeNull();
    expect(q("[data-testid=nav-evm-error]")!.textContent).toContain("Network switch was rejected in the wallet");
  });

  it("My positions (Robinhood Chain) shows the switch prompt instead of the positions, and the positions after switching", async () => {
    await onOtherNetwork(createElement(() => {
      const { wallet: w } = useEvmWalletConnection();
      return createElement(RhcPositionsSection, { wallet: w, signingEnabled: false, refreshKey: 0 });
    }));
    expect(q("[data-testid=rhc-wrong-network]")!.textContent).toContain("Switch to Robinhood Chain to see and manage your positions");
    expect(q("[data-testid=rhc-positions-panel]")).toBeNull();
    expect(panels.positions).not.toHaveBeenCalled();
    await click(q("[data-testid=rhc-wrong-network] button"));
    expect(q("[data-testid=rhc-wrong-network]")).toBeNull();
    expect(q("[data-testid=rhc-positions-panel]")).not.toBeNull();
  });

  it("the Open position dialog shows the switch prompt instead of the open panel, and the panel after switching", async () => {
    await onOtherNetwork(createElement(RhcOpenDialog, { pool: POOL, signingEnabled: true, onClose: () => {} }));
    expect(q("[data-testid=rhc-wrong-network]")!.textContent).toContain("Switch to Robinhood Chain to open this position");
    expect(panels.open).not.toHaveBeenCalled();
    await click(q("[data-testid=rhc-wrong-network] button"));
    expect(q("[data-testid=rhc-open-panel]")).not.toBeNull();
    expect(panels.open).toHaveBeenLastCalledWith(expect.objectContaining({ initialWallet: live.evm.wallet, autoConnect: false }));
  });

  it("a dialog opened on load waits for the silent restore instead of prompting", async () => {
    recordTermsAcceptance();
    wallet.shared = true;
    await render(createElement(RhcOpenDialog, { pool: POOL, signingEnabled: true, onClose: () => {} }));
    noWalletPrompt();
    expect(panels.open.mock.calls.every(([props]) => (props as { autoConnect: boolean }).autoConnect === false)).toBe(true);
    expect(panels.open).toHaveBeenLastCalledWith(expect.objectContaining({ initialWallet: live.evm.wallet }));
  });

  it("a wallet that moves to another network later flips the sections to the prompt", async () => {
    recordTermsAcceptance();
    wallet.shared = true;
    await render(createElement(RhcOpenDialog, { pool: POOL, signingEnabled: true, onClose: () => {} }));
    expect(q("[data-testid=rhc-open-panel]")).not.toBeNull();
    await act(async () => { emit("chainChanged", "0xa"); });
    expect(q("[data-testid=rhc-open-panel]")).toBeNull();
    expect(q("[data-testid=rhc-wrong-network]")).not.toBeNull();
  });
});
