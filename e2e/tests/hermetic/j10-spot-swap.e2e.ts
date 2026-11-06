// J10: homepage Top Gainers / Top Stocks and the Buy (USDC -> stock token) modal. Read-only: the card data and the
// quote answers are mocked (hermetic lane: no Jupiter, no RPC); nothing is signed or sent.
// SPOT_SWAP_SHOTS=/some/dir also saves a screenshot of each state (local review only).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";

const STOCKS = readFileSync(fileURLToPath(new URL("../../support/fixtures/stock-market.json", import.meta.url)), "utf8");
const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const NOTICE = "Not available to US persons or restricted regions. Tokens are issued by third parties.";
const IMPACT = "There isn't enough trading liquidity to buy this amount without moving the price more than 1%. Try a smaller amount.";
const quote = { outputMint: TSLAX, outputMintShort: "XsDo…oB", outputSymbol: "TSLAx", issuerName: "xStocks", xstocks: true, amount: "25000000", feeBps: 10,
  feeAmount: "25000", feeWalletShort: "CS5C…AK", quotedOut: "6631000", minOut: "6597845", priceImpactPct: "0.0008", newAccountRentLamports: 2039280,
  baseNetworkFeeLamports: 5000, outputDecimals: 8, slippageBps: 50 };
const shots = process.env.SPOT_SWAP_SHOTS;
const shot = async (page: Page, name: string) => { if (shots) await page.getByRole("dialog").screenshot({ path: `${shots}/${name}.png` }); };

async function mockApis(page: Page) {
  const quotes: Record<string, unknown>[] = [];
  // The wallet modal's stylesheet @imports a Google font. On /app that CSS is in the first HTML; here it arrives with the
  // Buy chunk, and the blocked font import surfaces as an unhandled "Event" rejection. Serve it empty instead.
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/wallet" || url.pathname === "/api/token-metadata") return route.fallback();   // context-level stubs
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });
    if (url.pathname === "/api/stock-market") return json(STOCKS);
    if (url.pathname === "/api/spot-swap-quote") {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      quotes.push(body);
      if (body.amount === "50000") return json({ error: IMPACT, code: "spot_swap_price_impact" }, 400);
      const wallet = body.wallet ? { walletLamports: "1200000", outputAccountExists: false, requiredLamports: "2044280", solSufficient: false,
        usdcBalance: "40000000", usdcSufficient: true } : null;
      return json({ underlying: body.underlying, quote, wallet });
    }
    if (url.pathname === "/api/spot-swap-prepare" || url.pathname === "/api/tx-send") return json({ error: "not in this test" }, 500);
    return json({});                                                                                       // anything else the page polls
  });
  return quotes;
}

async function openBuy(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const gainers = page.getByTestId("stock-card-gainers");
  await expect(gainers).toContainText("Top Gainers");
  await expect(page.getByTestId("stock-card-stocks")).toContainText("Top Stocks");
  await expect(page.getByTestId("stock-cards-notice")).toContainText(NOTICE);
  await expect(page.getByTestId("stock-card-stocks").getByTestId("stock-buy-MSTR")).toHaveCount(0);   // no issuer selected -> no Buy
  await expect(page.getByTestId("stock-card-stocks").getByTestId("stock-unsupported-MSTR")).toContainText("Not supported yet");
  await page.getByTestId("stock-card-stocks").getByTestId("stock-buy-TSLA").click();
  const modal = page.getByTestId("spot-swap-modal");
  await expect(modal.getByTestId("spot-swap-notice")).toHaveText(NOTICE);
  return modal;
}

test.describe("J10 homepage stock cards and Buy", () => {
  test("no wallet: quote with fee, minimum and deposit; over 1% impact is refused in plain words", async ({ page, wallet, guards }) => {
    guards.allowConsole(/^Failed to load resource: the server responded with a status of 400/);   // the mocked price-impact refusal
    const quotes = await mockApis(page);
    const modal = await openBuy(page);
    await expect(modal.getByTestId("spot-swap-issuer")).toHaveText("xStocks · XsDo…oB");
    await modal.getByTestId("spot-swap-amount").fill("25");
    await expect(modal.getByTestId("spot-swap-quoted")).toContainText("TSLAx");
    const summary = modal.getByTestId("spot-swap-summary");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await expect(modal.getByTestId("spot-swap-min")).toHaveCount(0);
    await summary.click();
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await expect(modal.getByTestId("spot-swap-min")).toContainText("TSLAx");
    await expect(modal.getByTestId("spot-swap-fee")).toContainText("0.025");
    await expect(modal.getByTestId("spot-swap-deposit")).toContainText("SOL");
    await expect(modal.getByTestId("spot-swap-connect")).toHaveText("Connect wallet to buy");
    await shot(page, "modal-quote");
    expect(quotes.at(-1)).toMatchObject({ underlying: "TSLA", amount: "25" });

    await modal.getByTestId("spot-swap-amount").fill("50000");
    await expect(modal.getByTestId("spot-swap-refused")).toHaveText(IMPACT);
    await expect(modal.getByTestId("spot-swap-quoted")).toHaveCount(0);
    await expect(modal).not.toContainText("spot_swap_");
    await shot(page, "modal-price-impact");
    expect(wallet.ledger).toEqual([]);
  });

  test("connected wallet with too little SOL: warning and Buy stays disabled", async ({ page, wallet }) => {
    await mockApis(page);
    const modal = await openBuy(page);
    await new ConnectModal(page, wallet).connect(modal.getByTestId("spot-swap-connect"));
    await expect(modal.getByTestId("spot-swap-submit")).toBeVisible();
    await modal.getByTestId("spot-swap-amount").fill("25");
    await expect(modal.getByTestId("spot-swap-sol-low")).toContainText("Not enough SOL");
    await expect(modal.getByTestId("spot-swap-submit")).toBeDisabled();
    await shot(page, "modal-sol-low");
    expect(wallet.ledger).toEqual([]);
  });
});
