// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { useSelectedController } from "./use-selected-controller";
const mocks = vi.hoisted(() => ({ sign: vi.fn() }));
const wallet = "11111111111111111111111111111111";
vi.mock("./wallet-connection", () => ({ useWalletConnection: () => ({
  address: "11111111111111111111111111111111", connected: true, signTransaction: mocks.sign,
}) }));
const selection = { positionMint: "position", inputMint: "mint", inputKind: "token" };
let controller: ReturnType<typeof useSelectedController>;
let root: Root;
let simulationFails: boolean;
let fetchMock: ReturnType<typeof vi.fn>;
function Harness() {
  const current = useSelectedController();
  useEffect(() => { controller = current; });
  return null;
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear(); simulationFails = false;
  mocks.sign.mockReset().mockRejectedValue(new Error("Wallet reached"));
  fetchMock = vi.fn(async (url: string) => {
    const quote = { wallet, ...selection, requested: "10000000", floorBps: 9900,
      toleranceBps: 100, passesFloor: false, roundtripCostInput: "137000", expiresAt: Date.now() + 30000 };
    if (url.startsWith("/api/wallet?")) return Response.json({
      positions: [{ positionMint: "position" }], assets: [{ kind: "token", mint: "mint", eligible: true }],
    });
    if (url.startsWith("/api/selected-state?")) return Response.json({
      wallet, ...selection, inputDecimals: 9, inputBalance: "1000000000",
      ownsNft: true, sufficientSol: true, unsupportedExtensions: [],
    });
    if (url === "/api/selected-quote") return Response.json(quote);
    if (url === "/api/selected-preflight") return simulationFails
      ? Response.json({ error: "Simulation failed" }, { status: 400 })
      : Response.json({ quote, simulated: true, expiresAt: quote.expiresAt });
    if (url === "/api/selected-prepare") {
      const transaction = new VersionedTransaction(new TransactionMessage({
        payerKey: new PublicKey(wallet), recentBlockhash: wallet, instructions: [],
      }).compileToV0Message());
      return Response.json({ quote, simulated: true, permit: "permit", startingBalances: { input: "0", a: "0", b: "0" },
        expiresAt: quote.expiresAt, blockhash: wallet,
        unsignedTransaction: btoa(String.fromCharCode(...transaction.serialize())) });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness))); await advance(10); await advance(10); await advance(10);
});
afterEach(async () => {
  await act(async () => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals();
});
it("simulates and allows preparation when the resale estimate is below the floor", async () => {
  await act(async () => controller.changeAmount("0.01")); await advance(1000);
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/selected-preflight")).toBe(true);
  expect(controller.quote?.passesFloor).toBe(false);
  expect(controller.quoteError).toBe(""); expect(controller.actionDisabled).toBe(false);
  await act(async () => controller.primaryAction());
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/selected-prepare")).toBe(true);
  expect(mocks.sign).toHaveBeenCalledOnce();
  expect(controller.error).toBe("Wallet reached");
});
it("still blocks signing when full simulation fails", async () => {
  simulationFails = true;
  await act(async () => controller.changeAmount("0.01")); await advance(1000);
  expect(controller.actionDisabled).toBe(true); expect(controller.quoteError).toBe("Simulation failed");
  await act(async () => controller.primaryAction());
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/selected-prepare")).toBe(false);
});
