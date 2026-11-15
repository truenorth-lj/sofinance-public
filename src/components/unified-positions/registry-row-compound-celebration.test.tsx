// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dexDescriptors } from "@/lib/dex/client";
import { STOCK_COIN_LOGOS } from "@/lib/compound-celebration/coins";
import type { UnifiedPosition } from "@/lib/unified-positions/model";
import { RegistryRowCompound } from "./registry-tools";

// The pipeline's state stands in for a Meteora compound that went through the wallet and landed (nothing is sent here).
const pipeline = vi.hoisted(() => ({ status: "idle" as string, signature: null as string | null }));
vi.mock("../transactions/use-tx-pipeline", () => ({
  useTxPipeline: () => ({ status: pipeline.status, signature: pipeline.signature, error: null, retryable: false, retry: () => {}, secondsLeft: null,
    locked: pipeline.status !== "idle" && pipeline.status !== "success" && pipeline.status !== "failed", runSteps: async () => {} }),
}));
vi.mock("../wallet-connection", async (importOriginal) => ({ ...await importOriginal<typeof import("../wallet-connection")>(),
  useWalletConnection: () => ({ address: "W", connected: true }) }));
vi.mock("../use-tx-wallet", () => ({ useTxWallet: () => null }));

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const position = { key: "meteora-dlmm:P", source: "meteora-dlmm", chain: "solana", nativeId: "P", poolId: "Q",
  tokenA: { id: TSLAX, symbol: null, decimals: 8 }, tokenB: { id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
  range: { mode: "price", lower: 1, upper: 2, current: 1.5 }, rangeStatus: "in", liquidity: "5", valueUsd: null,
  holdings: { liquidityRaw: { a: "1", b: "1" }, unclaimedFeesRaw: { a: "1", b: "1" } }, native: {} } as unknown as UnifiedPosition;

let container: HTMLDivElement, root: Root, rerender: () => void;
function Row({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [, bump] = useState(0);
  useLayoutEffect(() => { rerender = () => bump((n) => n + 1); }, []);
  return createElement(RegistryRowCompound, { position, descriptor: dexDescriptors.descriptorFor("meteora-dlmm")!,
    symbolOf: (token) => token.symbol ?? token.id.slice(0, 4), onConfirmed: () => {},
    slot: { disabled: false, otherActions: null, open, onOpen: () => setOpen(true), onClose: () => setOpen(false), unclaimedUsd: 1 } });
}
const burst = () => document.querySelector<HTMLElement>('[data-testid="compound-token-burst"]');
const popup = () => container.querySelector<HTMLDialogElement>('dialog[data-testid="compound-popup"]')!;
const land = async (status: "success" | "failed") => {
  pipeline.status = status; pipeline.signature = "sigM";
  await act(async () => rerender());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  pipeline.status = "idle"; pipeline.signature = null;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const r = this.dataset.testid === "compound-submit-done" ? { left: 600, top: 500, width: 120, height: 40 } : { left: 10, top: 700, width: 100, height: 40 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} } as DOMRect;
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const coinCentre = () => {
  const coin = burst()!.querySelector<HTMLElement>("[data-coin]:not([data-coin-knock])")!;
  return [Math.round(parseFloat(coin.style.left) + parseFloat(coin.style.width) / 2), Math.round(parseFloat(coin.style.top) + parseFloat(coin.style.height) / 2)];
};

it("Meteora row: a confirmed compound plays nothing until its Done is clicked, then the coins pop out of Done (the xStock by mint, not a shortened label) and the popup closes", async () => {
  await act(async () => root.render(createElement(Row, { startOpen: true })));
  expect(burst()).toBeNull();
  await land("success");
  const done = popup().querySelector<HTMLButtonElement>('[data-testid="compound-submit-done"]')!;
  expect(done.textContent).toBe("Done");
  expect(done.className).toContain("motion-safe:active:scale-[0.94]");
  // The confirmed landing alone plays nothing.
  expect(burst()).toBeNull();
  await act(async () => done.click());
  expect(popup().dataset.open).toBe("false");
  expect(burst()).not.toBeNull();
  expect(coinCentre()).toEqual([660, 520]);
  const logos = [...burst()!.querySelectorAll("[data-coin]")].map((coin) => coin.getAttribute("data-logo"));
  expect(logos.filter((logo) => logo === STOCK_COIN_LOGOS.TSLA).length).toBeGreaterThanOrEqual(logos.length / 2 - 1);
});

it("Meteora row: closing the result without Done, or a failed compound, plays nothing", async () => {
  await act(async () => root.render(createElement(Row, { startOpen: false })));
  await land("failed");
  expect(burst()).toBeNull();
  // Landed while the popup was closed: there is no Done to click, so nothing plays.
  await land("success");
  expect(burst()).toBeNull();
});
