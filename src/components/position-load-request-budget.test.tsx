// @vitest-environment happy-dom
// Request budget for opening /app on the Yield Compound tab. Every position read here costs several Solana RPC calls on the
// server (selected-state 4, compound-state about 9, compound-confirm about 2 plus a compound read), and the RPC provider
// rate-limits per second, so duplicate reads on load are what turned into "Solana RPC is temporarily unavailable".
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "./selected-app";
import { persistCompoundAttempt } from "@sofinance/engine/compound-attempt";
import { compoundHistoryFixture } from "@/lib/test-support/compound-history-fixture";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { USDC_MINT } from "@sofinance/engine/ids";

vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("./use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("./transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("./wallet-connection", async (importOriginal) => ({ ...await importOriginal<typeof import("./wallet-connection")>(),
  useWalletConnection: () => ({ address: wallet, connected: true, connect: vi.fn(), disconnect: vi.fn(), isMobile: false, walletsCount: 1,
    connectionError: "", signTransaction: vi.fn() }) }));

let wallet: string;
let container: HTMLDivElement, root: Root;
let fixture: ReturnType<typeof compoundHistoryFixture>;
let paths: string[];
const latencyMs = 300;
const otherMint = testKeypair(81).publicKey.toBase58();
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const count = (path: string) => paths.filter((item) => item === path).length;

function position(positionMint: string) {
  return { positionMint, positionAccount: "p", poolId: fixture.state.poolId, mintA: fixture.state.mintA, mintB: fixture.state.mintB,
    symbolA: "A", symbolB: "B", decimalsA: 8, decimalsB: 6, feeTierBps: 1, tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide: "inside", liquidity: "1" };
}

function selectedState(positionMint: string) {
  return { ...fixture.state, wallet, slot: 1, fetchedAt: Date.now(), positionMint, inputKind: "token", inputMint: USDC_MINT, inputDecimals: 6,
    inputTokenProgram: null, inputAccount: "a", inputBalance: "1000000", wsolBalance: "0", ataAExists: true, ataBExists: true, tickSpacing: 1,
    programA: "x", programB: "x", nftProgram: "x", ataA: "a", ataB: "b", balances: { a: "0", b: "0", input: "1000000" }, sqrtPriceX64: "1", tickCurrent: 0,
    tickLower: -10, tickUpper: 10, lowerSqrtX64: "1", upperSqrtX64: "2", price: "1", inRange: true, liquidity: "1", poolLiquidity: "1",
    currentAmounts: { a: "0", b: "0" }, ownsNft: true, paused: false, transferFee: false, frozen: false, unsupportedExtensions: [],
    solLamports: 1_000_000_000, sufficientSol: true };
}

function compoundState(positionMint: string) {
  return { ...selectedState(positionMint), ...fixture.state, wallet, positionMint, currentAmounts: { a: "0", b: "0" } };
}

function serve(confirmation: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    paths.push(url.pathname);
    await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { positionMint?: string } : {};
    const positionMint = url.searchParams.get("positionMint") || body.positionMint || fixture.state.positionMint;
    if (url.pathname === "/api/wallet") return Response.json({ wallet, slot: 1, fetchedAt: 1, positions: [position(otherMint), position(fixture.state.positionMint)],
      assets: [{ kind: "token", mint: USDC_MINT, tokenProgram: null, decimals: 6, balance: "1", totalBalance: "1", account: "a", eligible: true, reason: null }] });
    if (url.pathname === "/api/selected-state") return Response.json(selectedState(positionMint));
    if (url.pathname === "/api/compound-state") return Response.json(compoundState(positionMint));
    if (url.pathname === "/api/compound-confirm") return Response.json({ signature: fixture.attempt.signature, ...confirmation });
    return Response.json({});
  }));
}

async function open(initialMint = "") {
  await act(async () => root.render(createElement(SelectedApp as FunctionComponent<{ initialView: "compound"; initialMint: string }>,
    { initialView: "compound", initialMint })));
  for (let step = 0; step < 40; step++) await advance(100);
}

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear();
  fixture = compoundHistoryFixture(); wallet = fixture.wallet; paths = [];
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("opening the Yield Compound tab reads each position source once", () => {
  it("without a saved compound: one wallet scan, one selected read and one compound read", async () => {
    serve({ status: "pending", chainStatus: "pending", state: null });
    await open(fixture.state.positionMint);
    expect(paths).toEqual(["/api/wallet", "/api/selected-state", "/api/compound-state"]);
  });

  it("a saved compound that already finalized is checked once, and its fresh position read replaces a second compound read", async () => {
    persistCompoundAttempt(window.localStorage, fixture.attempt);
    serve({ status: "success", chainStatus: "success", state: compoundState(fixture.state.positionMint) });
    await open(fixture.state.positionMint);
    expect(count("/api/compound-confirm")).toBe(1);
    expect(count("/api/compound-state")).toBe(1);
    expect(count("/api/wallet")).toBe(1);
    // The finalized compound changed balances, so the selected reader refreshes once (it has no copy in the confirmation).
    expect(count("/api/selected-state")).toBe(2);
    expect(container.textContent).not.toContain("Yield reading failed");
  });

  it("a finalized confirmation without a position read still refreshes the compound read", async () => {
    persistCompoundAttempt(window.localStorage, fixture.attempt);
    serve({ status: "manual-review", chainStatus: "success", state: null });
    await open(fixture.state.positionMint);
    expect(count("/api/compound-confirm")).toBe(1);
    expect(count("/api/compound-state")).toBe(2);
  });

  it("a confirmation read for another position does not replace the selected position's read", async () => {
    persistCompoundAttempt(window.localStorage, fixture.attempt);
    serve({ status: "success", chainStatus: "success", state: compoundState(otherMint) });
    await open(fixture.state.positionMint);
    expect(count("/api/compound-confirm")).toBe(1);
    expect(count("/api/compound-state")).toBe(2);
  });
});
