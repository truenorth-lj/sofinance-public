// @vitest-environment happy-dom
// /app My positions with DEXes served through the registry (PR5): their rows join the Solana group, header/details and
// tools come only from the unified shape and the descriptor's capabilities; a deployment that does not serve the route
// (404, production today) renders exactly the Raydium-only page.
import { act, createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectedApp } from "../selected-app";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import { DEPOSIT_MINIMUM_UNAVAILABLE, dexDescriptors } from "@/lib/dex/client";
import { getTxNotices, resetTxNotices } from "@/lib/tx-pipeline";
import { RegistryPositionTool } from "./registry-tools";
import { resetPositionOpLocks } from "./position-op-lock";

const WALLET = testKeypair(91).publicKey.toBase58();
const RAYDIUM_MINT = testKeypair(92).publicKey.toBase58();
// A real listed pool (Meteora TSLA/TSLAx, 8k2c…haAh) and its mints: TSLA (6 decimals) is token X, TSLAx (8) is token Y.
const POOL = "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh";
const POSITION = testKeypair(94).publicKey.toBase58();
const MINT_A = "TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S";
const MINT_B = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const state = vi.hoisted(() => ({ dex: { status: 200, body: {} as unknown }, op: { status: 422, body: {} as unknown }, raydium: [] as unknown[], dexCalls: [] as [string, unknown][], icons: null as unknown, hold: null as Promise<void> | null,
  performance: { status: 200, body: {} as unknown }, walletHold: null as Promise<void> | null, positionsHold: null as Promise<void> | null, quoteAdd: { status: 200, body: {} as unknown } }));


vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));
vi.mock("../use-sol-usdc-price", () => ({ useSolUsdcPrices: () => ({ rate: null, usdcUsd: null }) }));
vi.mock("../use-token-metadata", () => ({ useTokenMetadata: () => ({}) }));
vi.mock("../pool-daily-apr-panel", () => ({ PoolDailyAprChart: ({ poolId, overlay }: { poolId: string; overlay?: { points: unknown[] } }) =>
  createElement("div", { "data-testid": "pool-daily-apr-chart", "data-pool": poolId, "data-overlay": overlay ? String(overlay.points.length) : "none" }) }));
vi.mock("../transaction-status-dialog", () => ({ TransactionStatusDialog: () => null }));
vi.mock("../wallet-connection", async (importOriginal) => ({ ...await importOriginal<typeof import("../wallet-connection")>(),
  useWalletConnection: () => ({ address: WALLET, connected: true, connect: vi.fn(), disconnect: vi.fn(), isMobile: false, walletsCount: 1,
    connectionError: "", signTransaction: vi.fn() }) }));

const HOLDINGS = { liquidityRaw: { a: "1250000", b: "98700000" }, unclaimedFeesRaw: { a: "1500", b: "230000" } };
const meteoraRow = (liquidity = "5000", holdings: unknown = HOLDINGS) => ({ key: `meteora-dlmm:${POSITION}`, source: "meteora-dlmm", chain: "solana", nativeId: POSITION, poolId: POOL,
  tokenA: { id: MINT_A, symbol: "TSLA", decimals: 6 }, tokenB: { id: MINT_B, symbol: "TSLAx", decimals: 8 },
  range: { mode: "price", lower: 0.98, upper: 1.02, current: 1 }, rangeStatus: "in", liquidity, valueUsd: null,
  ...(holdings === "omit" ? {} : { holdings }), native: { position: POSITION } });
/** The Meteora adapter's performance answer: summary fields plus the `/api/position-performance`-shaped report. */
const performanceBody = () => ({ key: `meteora-dlmm:${POSITION}`, depositedUsd: 500, withdrawnUsd: 0, feesClaimedUsd: 1.25, feesUnclaimedUsd: 0.75,
  currentValueUsd: 502, pnlUsd: 4, partial: false,
  report: { positionMint: POSITION, poolId: POOL, mintA: MINT_A, mintB: MINT_B, decimalsA: 6, decimalsB: 8, tickCurrent: 0, rangeSide: "inside",
    liquidity: "5000", openedAtIso: "2026-10-01T00:00:00.000Z", evaluatedAtIso: "2026-11-01T00:00:00.000Z", truncated: false, signatureCount: 3, ownsNft: null,
    cashflows: { openCount: 1, increaseCount: 0, decreaseCount: 0 },
    metrics: { holdingDays: 31, depositedUsd: 500, currentEquityUsd: 502, liquidityUsd: 501.25, uncollectedFeesUsd: 0.75, feesEarnedUsd: 2, pnlUsd: 4,
      holdingPeriodReturnPct: 0.8, annualizedReturnPct: 9.42, feeOnlyAprPct: 4.71, depositedRaw: { a: "1250000", b: "0" }, currentEquityRaw: { a: "1", b: "1" },
      liquidityAmountsRaw: { a: "1", b: "1" }, feesEarnedRaw: { a: "1", b: "1" }, uncollectedFeesRaw: { a: "1", b: "1" }, feesCollectedRaw: { a: "1", b: "1" } },
    pricing: { source: "jupiter", label: "Jupiter Price API v3", priceUsdA: 400, priceUsdB: 400 }, assumptions: "a", method: "m",
    realizedFeeAprSeries: { label: "Realized fee APR", assumptions: "r", points: [{ time: 1, date: "2026-10-02", aprPct: 4, kind: "collect" }] } },
});
const raydiumRow = { positionMint: RAYDIUM_MINT, positionAccount: "p", poolId: POOL, mintA: MINT_A, mintB: MINT_B, symbolA: "A", symbolB: "B",
  decimalsA: 8, decimalsB: 6, feeTierBps: 1, tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide: "inside", liquidity: "1" };

let container: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); resetTxNotices();
  state.dex = { status: 200, body: { positions: [meteoraRow()] } }; state.raydium = []; state.dexCalls = []; state.icons = null; state.hold = null; resetPositionOpLocks();
  state.performance = { status: 200, body: performanceBody() }; state.walletHold = null; state.positionsHold = null;
  state.quoteAdd = { status: 200, body: {} };
  state.op = { status: 422, body: { error: "This pool pays farming rewards, and claiming them isn't available here yet.", code: "UNSUPPORTED" } };
  window.history.replaceState(null, "", "/app");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://x");
    if (url.pathname === "/api/wallet") {
      if (state.walletHold) await state.walletHold;
      return Response.json({ wallet: WALLET, slot: 1, fetchedAt: 1, positions: state.raydium, assets: [] });
    }
    if (url.pathname === "/api/rwa-pairs" && state.icons) return Response.json({ pairs: [], tokenIcons: state.icons });
    if (url.pathname.startsWith("/api/dex/")) {
      state.dexCalls.push([url.pathname, JSON.parse(String(init?.body))]);
      if (url.pathname.endsWith("/performance")) return Response.json(state.performance.body, { status: state.performance.status });
      if (url.pathname.endsWith("/quote-add")) return Response.json(state.quoteAdd.body, { status: state.quoteAdd.status });
      if (!url.pathname.endsWith("/positions")) {
        if (state.hold) await state.hold; // a prepare still in flight
        return Response.json(state.op.body, { status: state.op.status });
      }
      if (state.positionsHold) await state.positionsHold;
      return state.dex.status === 404 ? new Response(null, { status: 404 }) : Response.json(state.dex.body, { status: state.dex.status });
    }
    return Response.json({ error: "not in this test" }, { status: 503 });
  }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); localStorage.clear(); });

/** Past the Add panel's 400 ms quote-add debounce, then settle. */
const afterAddCheck = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); }); await settle(); };
const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
async function render(props: Record<string, unknown> = {}) {
  await act(async () => root.render(createElement(SelectedApp as FunctionComponent<Record<string, unknown>>, props)));
  await settle();
}
/** A tab that shows All positions: Compound fees (the default) hides it once a Solana wallet is connected. */
const LISTED = { initialView: "deposit" } as const;
const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="position-fallback-select"]')];
const selectedKey = () => rows().find((row) => row.getAttribute("aria-pressed") === "true")?.getAttribute("data-position-key");
const groups = () => [...container.querySelectorAll('[data-testid="position-chain-group"]')].map((group) => [group.getAttribute("aria-label"),
  group.querySelector("button") ? [...group.querySelectorAll("button")].map((row) => row.firstChild?.textContent) : [...group.querySelectorAll("p")].map((row) => row.textContent)]);
const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("nav[aria-label='Position operations'] button")].find((b) => b.textContent === label)!;

describe("/app My positions with registry DEXes", () => {
  it("lists the wallet's served-DEX positions in the Solana group and selects one when the scan has none", async () => {
    await render();
    expect(state.dexCalls).toEqual([["/api/dex/meteora-dlmm/positions", { owner: WALLET }]]);
    // PR8: the page's default tool (Compound) now has a registry panel, never the Raydium one.
    expect(container.querySelector("[data-testid=registry-compound]")).toBeTruthy();
    expect(container.querySelector("#compound-view")?.textContent).not.toContain("Meteora");
    // Compound fees has no All positions card, and one position needs no dropdown beside its title.
    expect(container.querySelector('[aria-labelledby="all-positions-heading"]')).toBeNull();
    expect(container.querySelector("#compound-position")).toBeNull();
    await act(async () => tab("Add to position").click());
    await settle();
    expect(groups()).toEqual([["Solana", [`Meteora · TSLA/TSLAx · range 0.9800–1.0200 · In range · #${POSITION.slice(0, 4)}…${POSITION.slice(-4)}`]]]);
    expect(selectedKey()).toBe(`meteora-dlmm:${POSITION}`);
    expect(container.querySelector("[data-testid=registry-position-header]")?.textContent).toBe("In rangeRange 0.9800–1.0200");
    // PR9: Performance has a registry panel too (never the Raydium one).
    await act(async () => tab("Performance").click());
    await settle();
    expect(container.querySelector("#performance-view [data-testid=registry-performance]")).toBeTruthy();
  });

  it("Performance: the adapter's report in the shared summary, the pool chart with the realized fee overlay, and the exit estimate greyed with its reason", async () => {
    const meteora = dexDescriptors.descriptorFor("meteora-dlmm")!.capabilities;
    expect(meteora.performance).toEqual({ supported: true });
    expect(meteora.exitPreview).toEqual({ supported: false, reason: "Not available for this pool yet" });
    await render({ initialView: "performance" });
    expect(state.dexCalls).toContainEqual(["/api/dex/meteora-dlmm/performance", { positionKey: `meteora-dlmm:${POSITION}` }]);
    const panel = container.querySelector("[data-testid=registry-performance]")!;
    expect(panel.textContent).toContain("Est. fee-only APR (USD) · not a prediction4.71%");
    expect(panel.textContent).toContain("Current equity (USD)$502.0000");
    expect(panel.textContent).toContain("Fees accrued (USD)$2.0000");
    const chart = panel.querySelector("[data-testid=pool-daily-apr-chart]")!;
    expect(chart.getAttribute("data-pool")).toBe(POOL);
    expect(chart.getAttribute("data-overlay")).toBe("1");
    const exit = panel.querySelector("[data-testid=exit-preview-unavailable]")!;
    expect(exit.getAttribute("aria-disabled")).toBe("true");
    expect(exit.textContent).toBe("Exit estimateNot available for this pool yet");
    expect(panel.textContent).not.toContain("Meteora");
  });

  it("Performance: a stock represented in the overview keeps registry position details without duplicate stock cards", async () => {
    state.raydium = [raydiumRow];
    const body = performanceBody();
    state.performance.body = { ...body, report: { ...body.report, stock: {
      symbol: "TSLA", priceMint: MINT_A, priceUsd: 400, change24hPct: 1, sharesNow: 1.255, valueUsd: 502,
      sharesIn: null, firstDepositAtIso: null, entryPriceUsd: null, priceChangeUsd: null, priceChangePct: null,
      feeShares: 0.005, feeUsd: 2, totalUsd: null, sparkline24h: [], sparklineSinceEntry: [],
      entryPriceSource: null, entryUnavailableReason: "Entry price unavailable.",
    } } };
    await render({ initialView: "performance", initialPositionKey: `meteora-dlmm:${POSITION}` });
    const panel = container.querySelector('[data-testid="registry-performance"]')!;
    expect(container.querySelector('[data-testid="stocks-overview"]')).not.toBeNull();
    expect(panel.textContent).toContain("Position details");
    expect(panel.querySelector('[data-testid="stock-performance"]')).toBeNull();
    expect(panel.querySelector('[data-testid="position-detail-identity"]')?.textContent).toContain(POSITION);
    expect(panel.querySelector('[data-testid="pool-daily-apr-chart"]')).not.toBeNull();
  });

  it("Performance: a failed read shows the server's plain message and retries on request", async () => {
    state.performance = { status: 404, body: { error: "No Meteora position exists at that address.", code: "POSITION_NOT_FOUND" } };
    await render({ initialView: "performance" });
    const panel = () => container.querySelector("[data-testid=registry-performance]")!;
    expect(panel().querySelector("[role=alert]")?.textContent).toBe("No Meteora position exists at that address.");
    expect(panel().querySelector("[data-testid=exit-preview-unavailable]")).toBeNull();
    expect(state.dexCalls.filter(([path]) => path.endsWith("/performance"))).toHaveLength(1);
    state.performance = { status: 200, body: performanceBody() };
    const retry = [...panel().querySelectorAll("button")].find((button) => button.textContent === "Retry performance")!;
    await act(async () => retry.click());
    await settle();
    expect(panel().querySelector("[role=alert]")).toBeNull();
    expect(panel().textContent).toContain("4.71%");
    expect(state.dexCalls.filter(([path]) => path.endsWith("/performance"))).toHaveLength(2);
  });

  it.each(["registry-first", "wallet-first"] as const)("cold default selection shares its report read when %s", async (order) => {
    // Unique keys prevent a previous test's overview cache from concealing a duplicate read.
    const id = testKeypair(order === "registry-first" ? 181 : 182).publicKey.toBase58();
    const key = `meteora-dlmm:${id}`;
    state.dex.body = { positions: [{ ...meteoraRow(), key, nativeId: id }] };
    const body = performanceBody();
    const success = { ...body, key, report: { ...body.report, positionMint: id } };
    state.performance = { status: 404, body: { error: "Position temporarily unavailable" } };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    if (order === "registry-first") state.walletHold = pending;
    else state.positionsHold = pending;
    try {
      await render({ initialView: "performance" });
      // No report belongs to an unresolved default selection yet. The registry row remains navigable.
      expect(state.dexCalls.filter(([path]) => path.endsWith("/performance"))).toHaveLength(0);
      if (order === "registry-first") expect(rows().map((row) => row.getAttribute("data-position-key"))).toContain(key);
      await act(async () => { release(); }); await settle();
      expect(state.dexCalls.filter(([path]) => path.endsWith("/performance"))).toEqual([
        ["/api/dex/meteora-dlmm/performance", { positionKey: key }],
      ]);
      const panel = () => container.querySelector("[data-testid=registry-performance]")!;
      expect(panel().querySelector("[role=alert]")?.textContent).toBe("Position temporarily unavailable");
      state.performance = { status: 200, body: success };
      const retry = [...panel().querySelectorAll("button")].find((button) => button.textContent === "Retry performance")!;
      await act(async () => retry.click()); await settle();
      expect(panel().querySelector("[role=alert]")).toBeNull();
      expect(panel().textContent).toContain("4.71%");
      expect(state.dexCalls.filter(([path]) => path.endsWith("/performance"))).toHaveLength(2);
    } finally { await act(async () => { release(); }); }
  });

  it("does not delay an explicitly linked registry selection behind wallet discovery", async () => {
    const id = testKeypair(183).publicKey.toBase58();
    const key = `meteora-dlmm:${id}`;
    state.dex.body = { positions: [{ ...meteoraRow(), key, nativeId: id }] };
    const body = performanceBody();
    state.performance = { status: 200, body: { ...body, key, report: { ...body.report, positionMint: id } } };
    let release!: () => void;
    state.walletHold = new Promise<void>((resolve) => { release = resolve; });
    try {
      await render({ initialView: "performance", initialPositionKey: key });
      expect(container.querySelector("[data-testid=registry-performance]")?.textContent).toContain("4.71%");
      expect(state.dexCalls.filter(([path]) => path.endsWith("/performance"))).toHaveLength(1);
      await act(async () => { release(); }); await settle();
      expect(state.dexCalls.filter(([path]) => path.endsWith("/performance"))).toHaveLength(1);
    } finally { await act(async () => { release(); }); }
  });

  it("every registry tab follows the descriptor (no panel-level overrides)", () => {
    const meteora = dexDescriptors.descriptorFor("meteora-dlmm")!.capabilities;
    expect(meteora.withdraw).toEqual({ supported: true, partial: true, partialLeavesFees: true });
    expect(meteora.deposit.supported).toBe(true);
    expect(meteora.compound).toEqual({ supported: true });
    expect(meteora.withdrawOutputs).toEqual(["pool-tokens"]);
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
    // A partial withdraw leaves the fees in the position (descriptor capability), and says so before signing.
    expect(container.querySelector("[data-testid=registry-withdraw-fees]")?.textContent).toBe("Unclaimed fees stay in the position. Use Claim fees below.");
    const hundred = [...panel.querySelectorAll("button")].find((b) => b.textContent === "100%")!;
    await act(async () => hundred.click());
    expect(container.querySelector("[data-testid=registry-withdraw-fees]")).toBeNull();
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
    // The error is shown inline under the button, so no failure toast is raised on top of it (375 px).
    expect(getTxNotices().filter((notice) => notice.state === "failure")).toEqual([]);
  });

  it("Compound: shows the unclaimed fees and 'No platform fee', posts to the generic route and shows the server's plain refusal", async () => {
    state.op = { status: 400, body: { error: "This position has no unclaimed fees yet, so there is nothing to compound.", code: "INVALID_REQUEST" } };
    await render();
    const panel = container.querySelector("[data-testid=registry-compound]")!;
    expect(panel.textContent).toContain("adds them back into this position at its current price range, in one transaction. No swap is needed. No platform fee.");
    expect(panel.textContent).toContain("Unclaimed: 0.0015 TSLA · 0.0023 TSLAx");
    expect(container.querySelector("[data-testid=registry-compound-range]")).toBeNull(); // in range
    // In range the pool's own composition fee is stated (descriptor meta, not a DEX branch).
    expect(container.querySelector("[data-testid=registry-compound-pool-fee]")?.textContent).toContain("composition fee");
    expect(container.querySelector("[data-testid=registry-compound-blocked]")).toBeNull();
    const button = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Compound fees")!;
    await act(async () => button.click());
    await settle();
    expect(state.dexCalls.at(-1)).toEqual(["/api/dex/meteora-dlmm/compound", { owner: WALLET, positionKey: `meteora-dlmm:${POSITION}`, step: 1, priorSignatures: [] }]);
    expect(container.querySelector("[data-testid=registry-compound] [role=alert]")?.textContent).toContain("This position has no unclaimed fees yet, so there is nothing to compound.");
  });

  it("Compound with no unclaimed fees is disabled up front with a plain reason, and nothing is requested", async () => {
    state.dex = { status: 200, body: { positions: [meteoraRow("5000", { liquidityRaw: HOLDINGS.liquidityRaw, unclaimedFeesRaw: { a: "0", b: "0" } })] } };
    await render();
    expect(container.querySelector("[data-testid=registry-compound-blocked]")?.textContent).toBe("This position has no unclaimed fees yet, so there is nothing to compound.");
    const button = [...container.querySelectorAll<HTMLButtonElement>("[data-testid=registry-compound] button")].find((b) => b.textContent === "Nothing to compound")!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    await settle();
    expect((state.dexCalls as [string, unknown][]).filter(([path]) => path.endsWith("/compound"))).toEqual([]);
    expect(container.querySelector("[data-testid=registry-compound] [role=alert]")).toBeNull(); // no submit-then-error, no Try again
  });

  it("Compound out of range names the tokens: which fees go back in and which go to the wallet", async () => {
    state.dex = { status: 200, body: { positions: [{ ...meteoraRow(), rangeStatus: "below" }] } };
    await render();
    expect(container.querySelector("[data-testid=registry-compound-range]")?.textContent)
      .toBe("The price is outside this position's range. Only TSLA fees go back into the position; TSLAx fees go to your wallet.");
    expect(container.querySelector("[data-testid=registry-compound-pool-fee]")).toBeNull(); // out of range: no active-bin deposit
    const enabled = [...container.querySelectorAll<HTMLButtonElement>("[data-testid=registry-compound] button")].find((b) => b.textContent === "Compound fees")!;
    expect(enabled.disabled).toBe(false);
  });

  it("Compound out of range with fees only in the token the range can't hold is disabled and points to Claim", async () => {
    state.dex = { status: 200, body: { positions: [{ ...meteoraRow("5000", { liquidityRaw: HOLDINGS.liquidityRaw, unclaimedFeesRaw: { a: "0", b: "230000" } }), rangeStatus: "below" }] } };
    await render();
    expect(container.querySelector("[data-testid=registry-compound-blocked]")?.textContent)
      .toBe("There are no TSLA fees to put back while the price is outside the range. Claim the TSLAx fees to your wallet instead.");
    expect([...container.querySelectorAll<HTMLButtonElement>("[data-testid=registry-compound] button")].find((b) => b.textContent === "Nothing to compound")!.disabled).toBe(true);
  });

  it("one lock per position across ops: a Claim in flight locks Add / Withdraw / Compound, and switching tabs does not unlock", async () => {
    let finish!: () => void;
    state.hold = new Promise<void>((resolve) => { finish = resolve; });
    await render();
    await act(async () => tab("Withdraw").click());
    const claim = [...container.querySelectorAll<HTMLButtonElement>("[data-testid=registry-claim] button")].find((b) => b.textContent === "Claim fees")!;
    await act(async () => claim.click());
    await settle();
    expect(state.dexCalls.at(-1)?.[0]).toBe("/api/dex/meteora-dlmm/claim");
    // Same tab: the Withdraw panel is greyed and says why.
    const withdraw = [...container.querySelectorAll<HTMLButtonElement>("[data-testid=registry-withdraw] button")].find((b) => b.textContent === "Withdraw all and close")!;
    expect(withdraw.disabled).toBe(true);
    expect(container.querySelector("[data-testid=registry-withdraw] [data-testid=registry-position-locked]")?.textContent).toContain("Another transaction on this position is still in progress");
    // Another tab (the Claim panel unmounts): Compound and Add stay locked; nothing else is requested.
    await act(async () => tab("Compound fees").click());
    const compound = [...container.querySelectorAll<HTMLButtonElement>("[data-testid=registry-compound] button")].find((b) => b.textContent === "Compound fees")!;
    expect(compound.disabled).toBe(true);
    await act(async () => compound.click());
    await act(async () => tab("Add to position").click());
    const add = [...container.querySelectorAll<HTMLButtonElement>("[data-testid=registry-add] button")].find((b) => b.textContent === "Add liquidity")!;
    expect(add.disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>("input#registry-add-amount")!.disabled).toBe(true);
    expect((state.dexCalls as [string, unknown][]).filter(([path]) => path.endsWith("/compound"))).toEqual([]);
    // The claim's prepare ends (refused here): the lock is released for every op.
    await act(async () => finish());
    await settle();
    await act(async () => tab("Compound fees").click());
    expect([...container.querySelectorAll<HTMLButtonElement>("[data-testid=registry-compound] button")].find((b) => b.textContent === "Compound fees")!.disabled).toBe(false);
    expect(container.querySelector("[data-testid=registry-position-locked]")).toBeNull();
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
    // Greyed while the amount is checked against the range (quote-add), then enabled.
    expect(add.disabled).toBe(true);
    await afterAddCheck();
    expect(state.dexCalls).toContainEqual(["/api/dex/meteora-dlmm/quote-add", { owner: WALLET, positionKey: `meteora-dlmm:${POSITION}`, input: { token: MINT_A, amountRaw: "1500000" } }]);
    expect(add.disabled).toBe(false);
    await act(async () => add.click());
    await settle();
    expect(state.dexCalls.at(-1)).toEqual(["/api/dex/meteora-dlmm/add", expect.objectContaining({ owner: WALLET, input: { token: MINT_A, amountRaw: "1500000" }, step: 1 })]);
  });

  it("Add: an amount that would round to 0 in the range's steps greys Add and says the minimum (from quote-add)", async () => {
    state.quoteAdd = { status: 200, body: { depositMinimum: { token: MINT_A, tooSmall: true, minimumRaw: "48336" } } };
    await render();
    await act(async () => tab("Add to position").click());
    const panel = container.querySelector("[data-testid=registry-add]")!;
    const input = panel.querySelector<HTMLInputElement>("input#registry-add-amount")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "0.015"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await afterAddCheck();
    const add = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add liquidity")!;
    expect(add.disabled).toBe(true);
    expect(panel.querySelector("[data-testid=registry-add-too-small]")?.textContent)
      .toBe("This amount is too small to add to every price step in this range. Try at least 0.0484 TSLA.");
    await act(async () => add.click());
    expect((state.dexCalls as [string, unknown][]).filter(([path]) => path.endsWith("/add"))).toEqual([]);
  });

  it("Add: a failed quote-add check is not skipped: Add stays disabled with a plain try-again line", async () => {
    state.quoteAdd = { status: 503, body: { error: "Jupiter is busy" } };
    await render();
    await act(async () => tab("Add to position").click());
    const panel = container.querySelector("[data-testid=registry-add]")!;
    const input = panel.querySelector<HTMLInputElement>("input#registry-add-amount")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "1"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await afterAddCheck();
    const add = [...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add liquidity")!;
    expect(add.disabled).toBe(true);
    expect(panel.querySelector("[data-testid=registry-add-too-small]")?.textContent).toBe(DEPOSIT_MINIMUM_UNAVAILABLE);
    await act(async () => add.click());
    expect((state.dexCalls as [string, unknown][]).filter(([path]) => path.endsWith("/add"))).toEqual([]);
  });

  it("Add: the server could not price the input (unavailable) keeps Add disabled", async () => {
    state.quoteAdd = { status: 200, body: { depositMinimum: { token: MINT_A, tooSmall: true, minimumRaw: null, quoteChecked: false, unavailable: true } } };
    await render();
    await act(async () => tab("Add to position").click());
    const panel = container.querySelector("[data-testid=registry-add]")!;
    const input = panel.querySelector<HTMLInputElement>("input#registry-add-amount")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "1"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await afterAddCheck();
    expect([...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Add liquidity")!.disabled).toBe(true);
    expect(panel.querySelector("[data-testid=registry-add-too-small]")?.textContent).toBe(DEPOSIT_MINIMUM_UNAVAILABLE);
  });

  it("the header uses the stored token icons (same source as the pairs list) instead of the first-letter placeholder", async () => {
    state.icons = { solana: { [MINT_A]: "https://example.test/tsla.png", [MINT_B]: "https://example.test/tslax.png" }, robinhood: {} };
    await render(LISTED);
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
    await render(LISTED);
    const rows = [...container.querySelectorAll("[data-testid=registry-position-assets] dl")].map((row) => [...row.querySelectorAll("dt, dd")].map((cell) => cell.textContent));
    expect(rows).toHaveLength(2);
    // One grid per token: label | amount + symbol | USD, each cell exactly one value (PM 11/1: no wrapped second dash).
    expect(rows[0]!.map((cell) => cell?.replace(/\s+/g, " "))).toEqual(["Liquidity", "1.25 TSLA", "—", "Unclaimed fees", "0.0015 TSLA", "—"]);
    expect(rows[1]!.map((cell) => cell?.replace(/\s+/g, " "))).toEqual(["Liquidity", "0.987 TSLAx", "—", "Unclaimed fees", "0.0023 TSLAx", "—"]);
    // The USD cells sit in the grid's own column for both lines (same template for every token), so they align. A narrow
    // row (a phone) puts each label above its values so the amount keeps most of the width (container query, not screen).
    const grids = [...container.querySelectorAll("[data-testid=registry-position-assets] dl")].map((row) => row.className);
    expect(new Set(grids).size).toBe(1);
    expect(grids[0]).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(grids[0]).toContain("@md:grid-cols-[auto_minmax(0,1fr)_6rem]");
  });

  it("a registry position whose amounts were not read shows a dash on both rows, never zero (same rule as Robinhood Chain)", async () => {
    state.dex = { status: 200, body: { positions: [meteoraRow("5000", "omit")] } };
    await render(LISTED);
    const values = [...container.querySelectorAll("[data-testid=registry-position-assets] dd")].map((cell) => cell.textContent);
    expect(values.map((cell) => cell?.replace(/\s+/g, " "))).toEqual(["— TSLA", "—", "— TSLA", "—", "— TSLAx", "—", "— TSLAx", "—"]);
    state.dex = { status: 200, body: { positions: [meteoraRow("5000", { liquidityRaw: null, unclaimedFeesRaw: null })] } };
    await act(async () => root.unmount()); root = createRoot(container);
    await render(LISTED);
    expect([...container.querySelectorAll("[data-testid=registry-position-assets] dd")].map((cell) => cell.textContent)).toEqual(values);
  });

  it("a ?position= deep link to a registry position selects it over the scanned positions", async () => {
    state.raydium = [raydiumRow];
    await render({ ...LISTED, initialPositionKey: `meteora-dlmm:${POSITION}` });
    expect(selectedKey()).toBe(`meteora-dlmm:${POSITION}`);
    expect(groups()[0]![1]).toHaveLength(2);
  });

  it("a deployment that does not serve the route (404) renders the Raydium-only page: no source names, no Meteora text", async () => {
    state.dex = { status: 404, body: null }; state.raydium = [raydiumRow];
    await render(LISTED);
    const [[label, options]] = groups() as [[string, string[]]];
    expect(label).toBe("Solana");
    expect(options).toHaveLength(1);
    expect(options[0]).not.toMatch(/Raydium|Meteora/);
    expect(container.textContent).not.toContain("Meteora");
  });

  it("a DEX that fails shows its plain error and leaves the scanned positions usable", async () => {
    state.dex = { status: 502, body: { error: "Solana RPC is temporarily unavailable. Try again shortly." } }; state.raydium = [raydiumRow];
    await render(LISTED);
    expect(container.querySelector("[data-testid=registry-positions-error]")?.textContent)
      .toBe("Meteora: Solana RPC is temporarily unavailable. Try again shortly.");
    expect(selectedKey()).toBe(`raydium-clmm:${RAYDIUM_MINT}`);
  });

  it("rejects a response whose rows are not this DEX's positions", async () => {
    state.dex = { status: 200, body: { positions: [{ ...meteoraRow(), source: "raydium-clmm" }] } };
    await render(LISTED);
    expect(container.querySelector("[data-testid=registry-positions-error]")?.textContent).toBe("Meteora: Meteora returned positions in an unexpected shape.");
    expect(container.textContent).not.toContain("TSLA/TSLAx");
  });
});
