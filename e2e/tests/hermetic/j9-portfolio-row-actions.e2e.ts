// J9: the All positions row actions (Compound, Add, Withdraw) stay on one line at common widths, idle and while a
// compound waits for the wallet; on a phone the sticky Add liquidity bar never covers the positions list.
// Hermetic: API answers come from e2e/support/layout-mocks.ts (plus a synthetic compound prepare); every other host is
// blocked. The wallet prompt is held open and the context closes before anything could be signed; nothing is sent.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { installFakeWallet } from "../../fake-wallet/install";
import { FakeWallet } from "../../fake-wallet/node-signer";
import { ConnectModal } from "../../pages/connect-modal";
import { selectPosition } from "../../pages/all-positions";
import { installLayoutMocks } from "../../support/layout-mocks";
import { buildSingleSignerTx, randomAddress } from "../../support/tx";

async function setup(browser: Browser, baseURL: string | undefined, width: number) {
  const phone = width < 640;
  const context = await browser.newContext({ baseURL, viewport: { width, height: 800 }, isMobile: phone, hasTouch: phone, reducedMotion: "reduce" });
  const origin = new URL(baseURL ?? "http://localhost").origin;
  await context.route((url) => url.origin !== origin, (route) => route.abort());
  const wallet = new FakeWallet({ mode: "slow", slowMs: 600_000 }); // the prompt stays open for the whole test
  await installFakeWallet(context, wallet);
  await installLayoutMocks(context, wallet.address);
  let position: Record<string, unknown> | null = null;
  context.on("response", async (response) => {
    if (new URL(response.url()).pathname === "/api/wallet") position = ((await response.json()) as { positions: Record<string, unknown>[] }).positions[0]!;
  });
  await context.route("**/api/compound-prepare", async (route) => {
    const s = position!; const built = buildSingleSignerTx(wallet.address);
    await route.fulfill({ json: { permit: "e2e-permit", unsignedTransaction: built.b64, summary: { operation: "compound", simulated: true, state: s,
      positionMint: s.positionMint, positionAccount: s.positionAccount, poolId: s.poolId, priorSources: [],
      compoundAccounts: [s.mintA, s.mintB].map((mint, i) => ({ mint, seed: String(i).repeat(22), address: randomAddress(), program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", space: 165, rentLamports: 2039280 })),
      blockhash: built.tx.message.recentBlockhash, lastValidBlockHeight: 150, expiresAt: Date.now() + 75000, simulatedAt: Date.now(),
      liquidity: "100", startingLiquidity: "123456789", amountMaxA: "800", amountMaxB: "90000", simulatedEndingLiquidity: "123456889",
      simulatedDustA: "0", simulatedDustB: "0", simulatedSolDebitLamports: "5000", maxSolDebitLamports: "5000000",
      simulatedHarvest: { a: "901", b: "90100" }, simulatedRewards: [], feeLamports: 5000, rentLamports: 4078560,
      swaps: [{ inputMint: s.mintB, outputMint: s.mintA, inputAmount: "45000", minOutputAmount: "440", quotedOutputAmount: "449", inputDecimals: 8, outputDecimals: 6,
        poolId: s.poolId, sqrtPriceAfterX64: "1", feeAmount: "45", feeBps: 10 }], feeAmount: "45", feeBps: 10, feeWallet: randomAddress(), sizeBytes: 1000 } } });
  });
  await context.route("**/api/tx-send", (route) => route.abort());
  const page = await context.newPage();
  await page.goto("/app/portfolio", { waitUntil: "domcontentloaded" });
  await new ConnectModal(page, wallet).connect();
  await expect(page.getByTestId("position-fallback-select")).toHaveCount(2, { timeout: 30_000 });
  return { context, wallet, page };
}

/** Every row's action buttons share one line (same vertical middle), and no button's label wraps (one text line tall). */
async function expectOneLine(page: Page, label: string) {
  const rows = await page.getByTestId("row-actions").evaluateAll((bars) => bars.map((bar) => [...bar.querySelectorAll("button")].map((button) => {
    const box = button.getBoundingClientRect();
    return { text: button.textContent, middle: Math.round(box.top + box.height / 2), height: Math.round(box.height), right: Math.round(box.right),
      barRight: Math.round(bar.getBoundingClientRect().right) };
  })));
  expect(rows.length, label).toBeGreaterThan(0);
  for (const buttons of rows) {
    expect(buttons.map((b) => b.text), label).toEqual([expect.any(String), "Add", "Withdraw"]);
    const middles = buttons.map((b) => b.middle);
    expect(Math.max(...middles) - Math.min(...middles), `${label}: ${JSON.stringify(buttons)}`).toBeLessThanOrEqual(1);
    for (const b of buttons) expect(b.height, `${label}: ${b.text} on one text line`).toBeLessThanOrEqual(40);
    for (const b of buttons) expect(b.right, `${label}: ${b.text} inside its bar`).toBeLessThanOrEqual(b.barRight + 1);
  }
}
const raydiumRow = (page: Page) => page.getByTestId("position-row").filter({ has: page.locator('[data-position-key^="raydium-clmm:"]') });

for (const width of [1024, 1280, 1440, 768, 390, 375]) {
  test(`row actions stay on one line at ${width}px, idle and while confirming in the wallet`, async ({ browser, baseURL }) => {
    const { context, page } = await setup(browser, baseURL, width);
    await expectOneLine(page, `idle ${width}`);
    const row = raydiumRow(page);
    await selectPosition(page, (await row.getByTestId("position-fallback-select").getAttribute("data-position-key"))!);
    await row.locator('[data-tool="compound"]').click();
    await expect(row.locator('[data-tool="compound"]')).toHaveText("Confirming in wallet…");
    await expect(row.getByTestId("compound-protocol-fee")).toBeVisible();
    await expectOneLine(page, `confirming ${width}`);
    // From 1280 px the longest status label fits in full; narrower screens truncate it (the button's title keeps it).
    const label = row.locator('[data-tool="compound"] span');
    if (width >= 1280) expect(await label.evaluate((span) => span.scrollWidth <= span.clientWidth)).toBe(true);
    await expect(row.locator('[data-tool="compound"]')).toHaveAttribute("title", "Confirming in wallet…");
    await context.close();
  });
}

for (const width of [375, 390]) {
  test(`the sticky Add liquidity bar never covers the positions list at ${width}px`, async ({ browser, baseURL }) => {
    const { context, page } = await setup(browser, baseURL, width);
    const bar = page.getByTestId("mobile-action-bar");
    const list = page.getByRole("region", { name: "All positions", exact: true }).getByTestId("position-fallback-select").first();
    await page.waitForTimeout(500);
    await expect(bar).toHaveCount(0); // on load: Add to position is the default tab, but the form is below the list
    await page.getByRole("combobox", { name: "Position operations", exact: true }).selectOption("deposit");
    await page.locator("#deposit-view").scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollBy(0, 200));
    await expect(bar).toBeVisible();
    // Showing, it sits over the Add form only.
    const barTop = (await bar.boundingBox())!.y;
    const listBox = await list.boundingBox();
    if (listBox) expect(listBox.y + listBox.height).toBeLessThanOrEqual(barTop);
    expect((await page.locator("#deposit-view").boundingBox())!.y).toBeLessThan(barTop);
    // Back up to the list: the bar goes away again.
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(bar).toHaveCount(0);
    await context.close();
  });
}
