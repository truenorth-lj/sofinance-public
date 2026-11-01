// @vitest-environment happy-dom
// /app My positions with DEXes served through the registry (PR5): their rows join the Solana group, header/details and
// tools come only from the unified shape and the descriptor's capabilities; a deployment that does not serve the route
// (404, production today) renders exactly the Raydium-only page.
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "../selected-app";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { dexDescriptors } from "@/lib/dex/client";
import { registryPanelCapabilities } from "./registry-positions";
import { RegistryPositionTool } from "./registry-tools";

const WALLET = testKeypair(91).publicKey.toBase58();
const RAYDIUM_MINT = testKeypair(92).publicKey.toBase58();
// A real listed pool (Meteora TSLA/TSLAx, 8k2c…haAh) and its mints: TSLA (6 decimals) is token X, TSLAx (8) is token Y.
const POOL = "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh";
const POSITION = testKeypair(94).publicKey.toBase58();
const MINT_A = "TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S";
const MINT_B = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const state = vi.hoisted(() => ({ dex: { status: 200, body: {} as unknown }, op: { status: 422, body: {} as unknown }, raydium: [] as unknown[], dexCalls: [] as unknown[], routeOn: true, icons: null as unknown }));

vi.mock("@/lib/protocol-flags", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/protocol-flags")>(),
  isDexTxRouteEnabled: () => state.routeOn }));

vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("../use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("../use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("../transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("../wallet-connection", async (importOriginal) => ({ ...await importOriginal<typeof import("../wallet-connection")>(),
  useWalletConnection: () => ({ address: WALLET, connected: true, connect: vi.fn(), disconnect: vi.fn(), isMobile: false, walletsCount: 1,
    connectionError: "", signTransaction: vi.fn() }) }));

const HOLDINGS = { liquidityRaw: { a: "1250000", b: "98700000" }, unclaimedFeesRaw: { a: "1500", b: "230000" } };
const meteoraRow = (liquidity = "5000", holdings: unknown = HOLDINGS) => ({ key: `meteora-dlmm:${POSITION}`, source: "meteora-dlmm", chain: "solana", nativeId: POSITION, poolId: POOL,
  tokenA: { id: MINT_A, symbol: "TSLA", decimals: 6 }, tokenB: { id: MINT_B, symbol: "TSLAx", decimals: 8 },
  range: { mode: "price", lower: 0.98, upper: 1.02, current: 1 }, rangeStatus: "in", liquidity, valueUsd: null,
  ...(holdings === "omit" ? {} : { holdings }), native: { position: POSITION } });
const raydiumRow = { positionMint: RAYDIUM_MINT, positionAccount: "p", poolId: POOL, mintA: MINT_A, mintB: MINT_B, symbolA: "A", symbolB: "B",
  decimalsA: 8, decimalsB: 6, feeTierBps: 1, tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide: "inside", liquidity: "1" };

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  state.dex = { status: 200, body: { positions: [meteoraRow()] } }; state.raydium = []; state.dexCalls = []; state.routeOn = true; state.icons = null;
  state.op = { status: 422, body: { error: "This pool pays farming rewards, and claiming them isn't available here yet.", code: "UNSUPPORTED" } };
  window.history.replaceState(null, "", "/app");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/wallet") return Response.json({ wallet: WALLET, slot: 1, fetchedAt: 1, positions: state.raydium, assets: [] });
    if (url.pathname === "/api/rwa-pairs" && state.icons) return Response.json({ pairs: [], tokenIcons: state.icons });
    if (url.pathname.startsWith("/api/dex/")) {
      state.dexCalls.push([url.pathname, JSON.parse(String(init?.body))]);
      if (!url.pathname.endsWith("/positions")) return Response.json(state.op.body, { status: state.op.status });
      return state.dex.status === 404 ? new Response(null, { status: 404 }) : Response.json(state.dex.body, { status: state.dex.status });
    }
    return Response.json({ error: "not in this test" }, { status: 503 });
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
async function render(props: Record<string, unknown> = {}) {
  await act(async () => root.render(createElement(SelectedApp as FunctionComponent<Record<string, unknown>>, props)));
  await settle();
}
const select = () => container.querySelector<HTMLSelectElement>("select#position")!;
const groups = () => [...select().querySelectorAll("optgroup")].map((g) => [g.label, [...g.querySelectorAll("option")].map((o) => o.textContent)]);
const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("nav[aria-label='Position operations'] button")].find((b) => b.textContent === label)!;

describe("/app My positions with registry DEXes", () => {
  it("lists the wallet's served-DEX positions in the Solana group and selects one when the scan has none", async () => {
    await render();
    expect(state.dexCalls).toEqual([["/api/dex/meteora-dlmm/positions", { owner: WALLET }]]);
    expect(groups()).toEqual([["Solana", [`Meteora · TSLA/TSLAx · range 0.9800–1.0200 · In range · #${POSITION.slice(0, 4)}…${POSITION.slice(-4)}`]]]);
    expect(select().value).toBe(`meteora-dlmm:${POSITION}`);
    expect(container.querySelector("[data-testid=registry-position-header]")?.textContent).toBe("In rangeRange 0.9800–1.0200");
    // PR8: the page's default tool (Compound) now has a registry panel, never the Raydium one.
    expect(container.querySelector("[data-testid=registry-compound]")).toBeTruthy();
    expect(container.querySelector("#compound-view")?.textContent).not.toContain("Meteora");
    await act(async () => tab("Performance").click());
    expect(container.querySelector("#performance-view")?.textContent).toContain("Not available for this pool yet");
  });

  it("greys only the tool the registry panel has no UI for (performance); Add / Withdraw / Claim / Compound follow the descriptor", () => {
    const meteora = dexDescriptors.descriptorFor("meteora-dlmm")!.capabilities;
    expect(meteora.withdraw).toEqual({ supported: true, partial: true });
    expect(meteora.deposit.supported).toBe(true);
    const shown = registryPanelCapabilities(meteora);
    expect(shown.performance).toEqual({ supported: false, reason: "Not available for this pool yet" });
    expect(shown.compound).toEqual(meteora.compound);
    expect(meteora.compound).toEqual({ supported: true });
    expect(shown.deposit).toEqual(meteora.deposit);
    expect(shown.withdraw).toEqual(meteora.withdraw);
    expect(shown.claim).toEqual(meteora.claim);
    expect(shown.withdrawOutputs).toEqual(["pool-tokens"]);
    expect(shown.signer).toBe(meteora.signer);
  });

  it("Withdraw: partial slider, the outputs the descriptor lists, and the rent refund stated before signing at 100%", async () => {
    state.dex = { status: 200, body: { positions: [{ ...meteoraRow(), closeRefundLamports: "41899840" }] } };
    await render();
    await act(async () => tab("Withdraw").click());
    const panel = container.querySelector("[data-testid=registry-withdraw]")!;
    // One output (pool tokens) → no "Receive" select, a plain line instead; no USDC option anywhere.
    expect(panel.querySelector("select")).toBeNull();
    expect(panel.textContent).toContain("You receive TSLA and TSLAx in your wallet.");
    expect(panel.textContent).not.toContain("USDC");
    expect(container.querySelector("[data-testid=registry-withdraw-rent]")?.textContent)
      .toBe("Withdrawing 100% closes the position. Its rent, about 0.0419 SOL, comes back to your wallet.");
    const slider = panel.querySelector<HTMLInputElement>("input[type=range]")!;
    const fifty = [...panel.querySelectorAll("button")].find((b) => b.textContent === "50%")!;
    await act(async () => fifty.click());
    expect(slider.value).toBe("50");
    expect(container.querySelector("[data-testid=registry-withdraw-rent]")).toBeNull();
    expect([...panel.querySelectorAll("button")].some((b) => b.textContent === "Withdraw 50%")).toBe(true);
    // Claim fees sits under Withdraw when the descriptor supports it.
    expect(container.querySelector("[data-testid=registry-claim]")?.textContent).toContain("Unclaimed: 0.0015 TSLA · 0.0023 TSLAx");
  });

  it("a full withdraw goes through the shared pipeline to the generic route and shows the server's plain refusal", async () => {
    await render();
    await act(async () => tab("Withdraw").click());
    const button = [...container.querySelectorAll<HTMLButtonElement>("[data-testid=registry-withdraw] button")].find((b) => b.textContent === "Withdraw all and close")!;
    await act(async () => button.click());
    await settle();
    expect(state.dexCalls.at(-1)).toEqual(["/api/dex/meteora-dlmm/withdraw", expect.objectContaining({ owner: WALLET, positionKey: `meteora-dlmm:${POSITION}`, fraction: 1, output: "pool-tokens", step: 1, priorSignatures: [] })]);
    expect(container.querySelector("[data-testid=registry-withdraw] [role=alert]")?.textContent).toContain("This pool pays farming rewards, and claiming them isn't available here yet.");
  });

  it("Compound: shows the unclaimed fees and 'No platform fee', posts to the generic route and shows the server's plain refusal", async () => {
    state.op = { status: 400, body: { error: "This position has no unclaimed fees yet, so there is nothing to compound.", code: "INVALID_REQUEST" } };
    await render();
    const panel = container.querySelector("[data-testid=registry-compound]")!;
    expect(panel.textContent).toContain("adds them back into this position at its current price range, in one transaction. No swap is needed. No platform fee.");
    expect(panel.textContent).toContain("Unclaimed: 0.0015 TSLA · 0.0023 TSLAx");
    expect(container.querySelector("[data-testid=registry-compound-range]")).toBeNull(); // in range
    const button = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Compound fees")!;
    await act(async () => button.click());
    await settle();
    expect(state.dexCalls.at(-1)).toEqual(["/api/dex/meteora-dlmm/compound", { owner: WALLET, positionKey: `meteora-dlmm:${POSITION}`, step: 1, priorSignatures: [] }]);
    expect(container.querySelector("[data-testid=registry-compound] [role=alert]")?.textContent).toContain("This position has no unclaimed fees yet, so there is nothing to compound.");
  });

  it("Compound: out of range it says only one side goes back in; with no fees the button is disabled", async () => {
    state.dex = { status: 200, body: { positions: [{ ...meteoraRow("5000", { liquidityRaw: HOLDINGS.liquidityRaw, unclaimedFeesRaw: { a: "0", b: "0" } }), rangeStatus: "below" }] } };
    await render();
    expect(container.querySelector("[data-testid=registry-compound-range]")?.textContent)
      .toBe("The price is outside this position's range, so only the fees in the token the range holds right now go back in. The rest goes to your wallet.");
    const button = [...container.querySelectorAll<HTMLButtonElement>("[data-testid=registry-compound] button")].find((b) => b.textContent === "No fees to compound yet")!;
    expect(button.disabled).toBe(true);
  });

  it("Add offers the pool tokens and USDC (descriptor deposit inputs), states the swap fee, and posts the raw amount", async () => {
    await render();
    await act(async () => tab("Add to position").click());
    const panel = container.querySelector("[data-testid=registry-add]")!;
    expect([...panel.querySelectorAll("option")].map((o) => o.textContent)).toEqual(["TSLA", "TSLAx", "USDC"]);
    expect(panel.textContent).toContain("A 0.1% platform fee applies only to the part we swap into the pool tokens");
    const input = panel.querySelector<HTMLInputElement>("input#registry-add-amount")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "1.5"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    const add = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add liquidity")!;
    expect(add.disabled).toBe(false);
    await act(async () => add.click());
    await settle();
    expect(state.dexCalls.at(-1)).toEqual(["/api/dex/meteora-dlmm/add", expect.objectContaining({ owner: WALLET, input: { token: MINT_A, amountRaw: "1500000" }, step: 1 })]);
  });

  it("the header uses the stored token icons (same source as the pairs list) instead of the first-letter placeholder", async () => {
    state.icons = { solana: { [MINT_A]: "https://example.test/tsla.png", [MINT_B]: "https://example.test/tslax.png" }, robinhood: {} };
    await render();
    const srcs = [...container.querySelectorAll<HTMLImageElement>("[data-testid=registry-position-assets] img")].map((img) => img.getAttribute("src"));
    expect(srcs).toEqual(["https://example.test/tsla.png", "https://example.test/tslax.png"]);
  });

  it("panels follow capabilities: no Claim section when claim is unsupported, nothing for a tool the DEX lacks", async () => {
    const descriptor = dexDescriptors.descriptorFor("meteora-dlmm")!;
    const position = { ...meteoraRow(), key: `meteora-dlmm:${POSITION}` } as never;
    const capabilities = { ...descriptor.capabilities, claim: { supported: false as const, reason: "no" }, deposit: { supported: false as const, reason: "no" } };
    const props = { position, descriptor, capabilities, balances: {}, symbolOf: (t: { symbol: string | null }) => t.symbol ?? "?", onConfirmed: () => undefined };
    await act(async () => root.render(createElement(RegistryPositionTool, { ...props, view: "withdraw" })));
    expect(container.querySelector("[data-testid=registry-withdraw]")).toBeTruthy();
    expect(container.querySelector("[data-testid=registry-claim]")).toBeNull();
    await act(async () => root.render(createElement(RegistryPositionTool, { ...props, view: "deposit" })));
    expect(container.querySelector("[data-testid=registry-add]")).toBeNull();
    await act(async () => root.render(createElement(RegistryPositionTool, { ...props, capabilities: { ...capabilities, compound: { supported: false as const, reason: "no" } }, view: "compound" })));
    expect(container.querySelector("[data-testid=registry-compound]")).toBeNull();
  });

  it("shows the shared Liquidity and Unclaimed fees rows for the selected registry position (no USD until priced)", async () => {
    await render();
    const rows = [...container.querySelectorAll("[data-testid=registry-position-assets] dl")].map((row) => [...row.querySelectorAll("dt, dd")].map((cell) => cell.textContent));
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toBe("Liquidity");
    expect(rows[0]![1]).toMatch(/^1\.25\s*TSLA—$/);
    expect(rows[0]![2]).toBe("Unclaimed fees");
    expect(rows[0]![3]).toMatch(/^0\.0015 TSLA—$/);
    expect(rows[1]![1]).toMatch(/^0\.987\s*TSLAx—$/);
    expect(rows[1]![3]).toMatch(/^0\.0023 TSLAx—$/);
  });

  it("a registry position whose amounts were not read shows a dash on both rows, never zero (same rule as Robinhood Chain)", async () => {
    state.dex = { status: 200, body: { positions: [meteoraRow("5000", "omit")] } };
    await render();
    const values = [...container.querySelectorAll("[data-testid=registry-position-assets] dd")].map((cell) => cell.textContent);
    expect(values).toEqual(["—TSLA—", "— TSLA—", "—TSLAx—", "— TSLAx—"]);
    state.dex = { status: 200, body: { positions: [meteoraRow("5000", { liquidityRaw: null, unclaimedFeesRaw: null })] } };
    await act(async () => root.unmount()); root = createRoot(container);
    await render();
    expect([...container.querySelectorAll("[data-testid=registry-position-assets] dd")].map((cell) => cell.textContent)).toEqual(values);
  });

  it("a ?position= deep link to a registry position selects it over the scanned positions", async () => {
    state.raydium = [raydiumRow];
    await render({ initialPositionKey: `meteora-dlmm:${POSITION}` });
    expect(select().value).toBe(`meteora-dlmm:${POSITION}`);
    expect(groups()[0]![1]).toHaveLength(2);
  });

  it("a deployment that does not serve the route (404) renders the Raydium-only page: no source names, no Meteora text", async () => {
    state.dex = { status: 404, body: null }; state.raydium = [raydiumRow];
    await render();
    const [[label, options]] = groups() as [[string, string[]]];
    expect(label).toBe("Solana");
    expect(options).toHaveLength(1);
    expect(options[0]).not.toMatch(/Raydium|Meteora/);
    expect(container.textContent).not.toContain("Meteora");
  });

  it("where the dex route is off (production today) nothing is requested and the page is the Raydium-only page", async () => {
    state.routeOn = false; state.raydium = [raydiumRow];
    await render();
    expect(state.dexCalls).toEqual([]);
    const [[, options]] = groups() as [[string, string[]]];
    expect(options).toHaveLength(1);
    expect(options[0]).not.toMatch(/Raydium|Meteora/);
    expect(container.textContent).not.toContain("Meteora");
  });

  it("a DEX that fails shows its plain error and leaves the scanned positions usable", async () => {
    state.dex = { status: 502, body: { error: "Solana RPC is temporarily unavailable. Try again shortly." } }; state.raydium = [raydiumRow];
    await render();
    expect(container.querySelector("[data-testid=registry-positions-error]")?.textContent)
      .toBe("Meteora: Solana RPC is temporarily unavailable. Try again shortly.");
    expect(select().value).toBe(`raydium-clmm:${RAYDIUM_MINT}`);
  });

  it("rejects a response whose rows are not this DEX's positions", async () => {
    state.dex = { status: 200, body: { positions: [{ ...meteoraRow(), source: "raydium-clmm" }] } };
    await render();
    expect(container.querySelector("[data-testid=registry-positions-error]")?.textContent).toBe("Meteora: Meteora returned positions in an unexpected shape.");
    expect(container.textContent).not.toContain("TSLA/TSLAx");
  });
});
