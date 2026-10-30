// @vitest-environment happy-dom
// Nav wallets: "Solana wallet" and "EVM wallet" are separate buttons with separate state. Connecting or disconnecting
// one never touches the other.
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/app/rwa-pairs" }));

import { InkNav } from "./InkNav";
import { EvmWalletProvider } from "../evm-wallet-connection";
import { createEvmSession, type EvmSession } from "@/lib/rhc-wallet/evm-session";
import type { Eip1193Provider } from "@/lib/rhc-wallet/eip1193";

const SOL = "EweTgJ6vaQDZyH5nk5uaK5iD7n1qr7BXTaxewcjQNEjb"; // the Solana test wallet
const EVM = "0xb95b77e9429643cbafde865fa2a9f687e8d21b04"; // the EVM test wallet

const listeners = new Map<string, (...args: unknown[]) => void>();
const evmRequest = vi.fn(async ({ method }: { method: string }) =>
  method === "eth_chainId" ? "0x1237" : method === "eth_requestAccounts" || method === "eth_accounts" ? [EVM] : null);
const provider: Eip1193Provider = { request: evmRequest, on: (e, l) => { listeners.set(e, l); }, removeListener: (e) => { listeners.delete(e); } };
const discover = vi.fn(async () => [{ info: { uuid: "mm", name: "MetaMask", rdns: "io.metamask" }, provider }]);

const solana = { connect: vi.fn(), disconnect: vi.fn() };
function Harness({ initialSolana }: { initialSolana: string | null }) {
  // Stands in for the Solana wallet adapter context: its own state, its own handlers.
  const [address, setAddress] = useState<string | null>(initialSolana);
  return createElement(InkNav, {
    wallet: address, connected: Boolean(address),
    onConnect: () => { solana.connect(); setAddress(SOL); },
    onDisconnect: () => { solana.disconnect(); setAddress(null); },
  });
}

let container: HTMLDivElement; let root: Root; let session: EvmSession;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); listeners.clear(); evmRequest.mockClear(); discover.mockClear(); solana.connect.mockClear(); solana.disconnect.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  session = createEvmSession({ discover, storage: () => localStorage });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const sol = () => container.querySelector<HTMLButtonElement>("[data-testid=nav-solana-wallet]")!;
const evm = () => container.querySelector<HTMLButtonElement>("[data-testid=nav-evm-wallet]");
const click = async (el: HTMLElement) => { await act(async () => { el.click(); await new Promise(r => setTimeout(r, 0)); }); };
async function render({ initialSolana = null as string | null, enabled = true } = {}) {
  await act(async () => { root.render(createElement(EvmWalletProvider, { enabled, session }, createElement(Harness, { initialSolana }))); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

describe("InkNav wallets", () => {
  it("shows two separate buttons when neither is connected", async () => {
    localStorage.setItem("sofi:evm-wallet:v1", JSON.stringify({ disconnected: true }));
    await render();
    expect(sol().textContent).toBe("Solana wallet");
    expect(evm()!.textContent).toBe("EVM wallet");
    expect(sol().dataset.connected).toBe("false");
    expect(evm()!.dataset.connected).toBe("false");
  });

  it("connecting the EVM wallet leaves Solana alone, and the reverse", async () => {
    localStorage.setItem("sofi:evm-wallet:v1", JSON.stringify({ disconnected: true }));
    await render();
    await click(evm()!);
    expect(evm()!.textContent).toBe("0xb95b…1b04RHC");
    expect(evm()!.getAttribute("aria-label")).toBe("EVM wallet 0xb95b…1b04 on Robinhood Chain, connected. Disconnect");
    expect(sol().dataset.connected).toBe("false");
    expect(solana.connect).not.toHaveBeenCalled();

    await click(sol());
    expect(sol().textContent).toBe("EweT…NEjbSOL");
    expect(session.getState().wallet?.address).toBe(EVM);
    const evmCalls = evmRequest.mock.calls.length;

    await click(sol());                                   // Solana disconnect
    expect(solana.disconnect).toHaveBeenCalledTimes(1);
    expect(sol().dataset.connected).toBe("false");
    expect(evm()!.dataset.connected).toBe("true");
    expect(evmRequest.mock.calls.length).toBe(evmCalls);  // the EVM wallet was not even asked

    await click(sol());
    await click(evm()!);                                  // EVM disconnect
    expect(evm()!.dataset.connected).toBe("false");
    expect(sol().dataset.connected).toBe("true");
    expect(solana.disconnect).toHaveBeenCalledTimes(1);
  });

  it("restores the EVM wallet on reload without a prompt, beside an already connected Solana wallet", async () => {
    await render({ initialSolana: SOL });
    expect(evm()!.dataset.connected).toBe("true");
    expect(evmRequest.mock.calls.map(c => c[0].method)).toEqual(["eth_accounts", "eth_chainId"]);
    expect(sol().dataset.connected).toBe("true");
  });

  it("follows wallet events: another network shows an EVM hint, an emptied account list disconnects only EVM", async () => {
    await render({ initialSolana: SOL });
    await act(async () => { listeners.get("chainChanged")!("0x1"); });
    expect(evm()!.textContent).toBe("0xb95b…1b04EVM");
    expect(evm()!.getAttribute("aria-label")).toContain("another network");
    await act(async () => { listeners.get("accountsChanged")!([]); });
    expect(evm()!.dataset.connected).toBe("false");
    expect(sol().dataset.connected).toBe("true");
    expect(solana.disconnect).not.toHaveBeenCalled();
  });

  it("shows a connect error next to the buttons, and no EVM button where Robinhood Chain is off", async () => {
    discover.mockResolvedValueOnce([]);
    localStorage.setItem("sofi:evm-wallet:v1", JSON.stringify({ disconnected: true }));
    await render();
    await click(evm()!);
    expect(container.querySelector("[data-testid=nav-evm-error]")!.textContent).toContain("No EVM wallet found");
    expect(sol().dataset.connected).toBe("false");
    await act(async () => root.unmount());
    root = createRoot(container); session = createEvmSession({ discover, storage: () => localStorage });
    discover.mockClear();
    await render({ enabled: false });
    expect(evm()).toBeNull();
    expect(sol()).not.toBeNull();
    expect(discover).not.toHaveBeenCalled();
  });

  it("renders no wallet buttons on pages without wallet handlers (docs, blog, terms)", async () => {
    await act(async () => { root.render(createElement(EvmWalletProvider, { enabled: true, session }, createElement(InkNav))); });
    expect(container.querySelector("[data-testid=nav-wallets]")).toBeNull();
  });
});
