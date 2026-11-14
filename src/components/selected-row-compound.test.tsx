// @vitest-environment happy-dom
// Compound lives only on the position row (LJ 11/14): the row button drives the real controller, also from a row that is
// not selected yet (it selects it, waits for its latest fees, then starts once), and there is no Compound fees tab.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { USDC_MINT } from "@sofinance/engine/ids";

vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
const wallet = testKeypair(171).publicKey.toBase58();
const FIRST = testKeypair(172).publicKey.toBase58();
const SECOND = testKeypair(173).publicKey.toBase58();
const mintB = testKeypair(174).publicKey.toBase58();
const state = (positionMint: string) => ({ wallet, positionMint, inputMint: USDC_MINT, inputKind: "token", inputDecimals: 6,
  inputBalance: "1000000", ownsNft: true, sufficientSol: true, unsupportedExtensions: [],
  mintA: USDC_MINT, mintB, decimalsA: 6, decimalsB: 9, currentAmounts: { a: "1000000", b: "1000000000" },
  balances: { a: "1000000", b: "1000000000" }, solLamports: 1000000000, price: "1", tickLower: 0, tickUpper: 10,
  slot: 1, liquidity: "1000000", rangeSide: "inside", inRange: true, poolId: testKeypair(175).publicKey.toBase58(),
  fees: { a: "1000", b: "0" }, rewards: [], eligible: true });
let root: Root, container: HTMLDivElement, connection: WalletConnection;
let calls: { path: string; body?: Record<string, unknown> }[];
let holdState: Promise<void> | null;
const prepares = () => calls.filter((call) => call.path === "/api/compound-prepare");
const rowOf = (mint: string) => container.querySelector(`[data-position-key="raydium-clmm:${mint}"]`)!.closest("li")!;
const compoundOf = (mint: string) => rowOf(mint).querySelector<HTMLButtonElement>('[data-testid="position-row-action"][data-tool="compound"]')!;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(30); }); };

beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear(); calls = []; holdState = null;
  window.history.replaceState(null, "", "/app");
  connection = { address: wallet, connected: true, connect: vi.fn(), disconnect: vi.fn(), isMobile: false,
    walletsCount: 1, connectionError: "", signTransaction: vi.fn() };
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function(this: HTMLDialogElement) { this.setAttribute("open", ""); });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function(this: HTMLDialogElement) { this.removeAttribute("open"); });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, body });
    if (path.startsWith("/api/wallet?")) return Response.json({ wallet, positions: [FIRST, SECOND].map((mint) => ({ ...state(mint), nftAccount: wallet })),
      assets: [{ kind: "token", mint: USDC_MINT, balance: "1000000", totalBalance: "1000000", decimals: 6, eligible: true, symbol: "USDC" }] });
    if (path.startsWith("/api/selected-state?")) return Response.json(state(new URL(path, "http://x").searchParams.get("positionMint") ?? FIRST));
    if (path === "/api/compound-state") { if (holdState) await holdState; return Response.json(state(String(body?.positionMint))); }
    if (path === "/api/token-metadata") return Response.json({ tokens: {} });
    if (path === "/api/sol-usdc-price") return Response.json({ rate: 100, usdcUsd: 1 });
    if (path === "/api/compound-prepare") return new Promise<Response>(() => {}); // stays in flight: nothing reaches the wallet
    return Response.json({ error: "not in this test" }, { status: 503 });
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(connection.signTransaction).not.toHaveBeenCalled();
  container.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => root.render(<WalletConnectionContext.Provider value={connection}><SelectedApp initialMint={FIRST} /></WalletConnectionContext.Provider>));
  await settle();
}

it("opens on Add to position with no Compound fees tab; every Raydium row has its own Compound", async () => {
  await mount();
  const tabs = [...container.querySelectorAll("nav[aria-label='Position operations'] button")].map((b) => b.textContent);
  expect(tabs).toEqual(["Performance", "Add to position", "Withdraw"]);
  expect(container.querySelector<HTMLElement>("#deposit-view")?.hidden).toBe(false);
  expect(container.querySelector("#compound-view")).toBeNull();
  expect(container.textContent).not.toContain("One-click compound");
  expect(compoundOf(FIRST).textContent).toBe("Compound");
  expect(compoundOf(SECOND).textContent).toBe("Compound");
});

it("the selected row's Compound starts the compound for that position", async () => {
  await mount();
  await act(async () => compoundOf(FIRST).click());
  await settle();
  expect(prepares().map((call) => call.body?.positionMint)).toEqual([FIRST]);
  expect(compoundOf(FIRST).disabled).toBe(true);
  expect(compoundOf(SECOND).disabled).toBe(true); // one operation at a time
});

it("another row's Compound selects that position, waits for its latest fees, then starts once for it", async () => {
  await mount();
  let release!: () => void;
  holdState = new Promise<void>((resolve) => { release = resolve; });
  await act(async () => compoundOf(SECOND).click());
  await settle();
  expect(new URL(window.location.href).searchParams.get("position")).toBe(`raydium-clmm:${SECOND}`);
  expect(prepares()).toEqual([]);
  expect(compoundOf(SECOND).textContent).toBe("Loading latest fees…");
  expect(compoundOf(SECOND).disabled).toBe(true);
  holdState = null;
  await act(async () => release());
  await settle();
  expect(prepares().map((call) => call.body?.positionMint)).toEqual([SECOND]);
  // Clicking again while it runs starts nothing new.
  await act(async () => compoundOf(SECOND).click());
  await settle();
  expect(prepares()).toHaveLength(1);
});
