// @vitest-environment happy-dom
// A slow exit-preview for position A must never render once position B (or another NFT account) is selected.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PositionPerformancePanel } from "./position-performance-panel";
import { PositionExitEstimate } from "./position-exit-estimate";
import { WalletConnectionContext, type WalletConnection } from "./wallet-connection";
import fixture from "./__fixtures__/position-performance-sample.json";

vi.mock("./pool-activity-panel", () => ({ PoolActivityPanel: () => null }));
vi.mock("./pool-daily-apr-panel", () => ({ PoolDailyAprChart: () => null }));
vi.mock("./use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));

const MINT_A = fixture.positionMint;
const MINT_B = "DemoPositionB11111111111111111111111111111";
const ATA_A = "33333333333333333333333333333333";
const ATA_B = "44444444444444444444444444444444";
const WALLET = "22222222222222222222222222222222";
const exitBody = (usdc: string) => ({ status: "verified-preview", executable: false, sent: false, recoveryUSDCAtomic: usdc,
  recoverySOLLamports: "8580200", localExpiresAt: "2999-01-01T00:00:00.000Z" });
const flush = async (ms = 100) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

let container: HTMLDivElement; let root: Root;
type Pending = { account: string | null; mint: string | null; resolve: (usdcAtomic: string) => void; signal: AbortSignal };
let pending: Pending[];

// Deliberately ignores AbortSignal (worst-case transport): resolves only when the test says so.
function stubFetch() {
  vi.stubGlobal("fetch", vi.fn((input: string, init?: { signal: AbortSignal }) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/position-performance") return Promise.resolve(Response.json({ ...fixture, positionMint: url.searchParams.get("positionMint") }));
    if (url.pathname === "/api/lp-decision/exit-preview") {
      return new Promise<Response>((resolve) => pending.push({ account: url.searchParams.get("nftAccount"), mint: url.searchParams.get("positionId"),
        signal: init!.signal, resolve: (usdc) => resolve(Response.json(exitBody(usdc))) }));
    }
    return Promise.resolve(Response.json({ positions: [] }));
  }));
}
const connection: WalletConnection = { address: WALLET, connected: true, connect: vi.fn(), disconnect: vi.fn(), isMobile: false,
  walletsCount: 1, connectionError: "", signTransaction: async (tx) => tx };
const panel = (mint: string, account: string) => act(async () => root.render(createElement(WalletConnectionContext.Provider, { value: connection },
  createElement(PositionPerformancePanel, { embedded: true, selectedMint: mint, selectedNftAccount: account }))));

beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); pending = []; stubFetch();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("position switch while an exit-preview is in flight", () => {
  it("panel: stale response for position A never renders for position B (transport ignores abort)", async () => {
    await panel(MINT_A, ATA_A); await flush(); await flush();
    expect(pending.map((p) => [p.mint, p.account])).toEqual([[MINT_A, ATA_A]]);
    await panel(MINT_B, ATA_B); await flush(); await flush();
    expect(pending.map((p) => [p.mint, p.account])).toEqual([[MINT_A, ATA_A], [MINT_B, ATA_B]]);
    expect(pending[0]!.signal.aborted).toBe(true);                 // old request was cancelled
    await act(async () => pending[0]!.resolve("999000000"));       // late stale answer for A
    expect(container.textContent).not.toContain("999.000000 USDC");
    expect(container.textContent).toContain("Calculating USDC + SOL estimate…");   // B still pending, not showing A's number
    await act(async () => pending[1]!.resolve("1000000"));
    expect(container.textContent).toContain("1.000000 USDC + 0.008580200 SOL");
    await act(async () => pending[0]!.resolve("999000000"));       // and again, after B is shown
    expect(container.textContent).not.toContain("999.000000 USDC");
  });

  it("panel: B answers first, then A's stale answer arrives", async () => {
    await panel(MINT_A, ATA_A); await flush(); await flush();
    await panel(MINT_B, ATA_B); await flush(); await flush();
    await act(async () => pending[1]!.resolve("2000000"));
    await act(async () => pending[0]!.resolve("999000000"));
    expect(container.textContent).toContain("2.000000 USDC");
    expect(container.textContent).not.toContain("999.000000 USDC");
  });

  it("evidence: same position, nftAccount changes mid-flight -> old account's answer is dropped and a fresh request is made for the new account", async () => {
    const renderWith = (account: string) => act(async () => root.render(createElement(PositionExitEstimate,
      { positionId: MINT_A, nftAccount: account, nftAccountPending: !account, autoExit: true })));
    await renderWith(ATA_A); await flush();
    expect(pending.map((p) => p.account)).toEqual([ATA_A]);
    await renderWith(ATA_B); await flush();
    expect(pending.map((p) => p.account)).toEqual([ATA_A, ATA_B]);
    await act(async () => pending[0]!.resolve("999000000"));
    expect(container.textContent).not.toContain("999.000000 USDC");
    await act(async () => pending[1]!.resolve("3000000"));
    expect(container.textContent).toContain("3.000000 USDC");
  });

  it("evidence: nftAccount disappears mid-flight (state refresh) -> in-flight answer is dropped, waiting message returns, nothing stale shown", async () => {
    const renderWith = (account?: string) => act(async () => root.render(createElement(PositionExitEstimate,
      { positionId: MINT_A, nftAccount: account, nftAccountPending: !account, autoExit: true })));
    await renderWith(ATA_A); await flush();
    await renderWith(undefined); await flush();
    await act(async () => pending[0]!.resolve("999000000"));
    expect(container.textContent).not.toContain("999.000000 USDC");
    expect(container.textContent).toContain("Waiting for position accounts…");
  });
});
