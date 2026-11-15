// J9: the All positions row actions (Compound, Add, Withdraw, Activity) stay on one line on desktop widths, idle and while
// a compound waits for the wallet; on narrower screens Compound takes its own line above the other three. Each button
// opens a popup: a centered modal on desktop, a bottom sheet on a phone (LJ 11/14).
// Hermetic: API answers come from e2e/support/layout-mocks.ts (plus a synthetic compound prepare); every other host is
// blocked. The wallet prompt is held open and the context closes before anything could be signed; nothing is sent.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { installFakeWallet } from "../../fake-wallet/install";
import { FakeWallet } from "../../fake-wallet/node-signer";
import { ConnectModal } from "../../pages/connect-modal";
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

type Box = { text: string | null; top: number; middle: number; height: number; right: number; barRight: number };
async function rowButtons(page: Page): Promise<Box[][]> {
  return page.getByTestId("row-actions").evaluateAll((bars) => bars.map((bar) => Array.from(bar.querySelectorAll("button")).map((button) => {
    const box = button.getBoundingClientRect();
    return { text: button.textContent, top: Math.round(box.top), middle: Math.round(box.top + box.height / 2), height: Math.round(box.height),
      right: Math.round(box.right), barRight: Math.round(bar.getBoundingClientRect().right) };
  })));
}
const sameLine = (buttons: Box[]) => Math.max(...buttons.map((b) => b.middle)) - Math.min(...buttons.map((b) => b.middle));

/**
 * Desktop (from 1024 px): every row's four buttons share one line. Narrower: Compound has its own line and Add, Withdraw
 * and Activity share the next. Never a wrapped label (one text line tall) or a button outside its bar.
 */
async function expectRowLayout(page: Page, label: string, desktop: boolean) {
  const rows = await rowButtons(page);
  expect(rows.length, label).toBeGreaterThan(0);
  for (const buttons of rows) {
    expect(buttons.map((b) => b.text), label).toEqual([expect.any(String), "Add", "Withdraw", "Activity"]);
    if (desktop) expect(sameLine(buttons), `${label}: ${JSON.stringify(buttons)}`).toBeLessThanOrEqual(1);
    else {
      expect(sameLine(buttons.slice(1)), `${label}: ${JSON.stringify(buttons)}`).toBeLessThanOrEqual(1);
      expect(buttons[0]!.top + buttons[0]!.height, `${label}: Compound above the others`).toBeLessThanOrEqual(buttons[1]!.top);
    }
    for (const b of buttons) expect(b.height, `${label}: ${b.text} on one text line`).toBeLessThanOrEqual(44);
    for (const b of buttons) expect(b.right, `${label}: ${b.text} inside its bar`).toBeLessThanOrEqual(b.barRight + 1);
  }
}
const raydiumRow = (page: Page) => page.getByTestId("position-row").filter({ has: page.locator('[data-position-key^="raydium-clmm:"]') });

for (const width of [1024, 1280, 1440, 768, 390, 375]) {
  test(`row actions keep their layout at ${width}px, idle and while confirming in the wallet`, async ({ browser, baseURL }) => {
    const desktop = width >= 1024;
    const { context, page } = await setup(browser, baseURL, width);
    await expectRowLayout(page, `idle ${width}`, desktop);
    const row = raydiumRow(page);
    await row.locator('[data-tool="compound"]').click();
    const popup = page.locator('dialog[data-testid="compound-popup"][data-open="true"]');
    await expect(popup).toBeVisible();
    await expect(popup.getByTestId("compound-confirm-fee")).toHaveText("0.10%");
    const confirm = popup.getByTestId("compound-confirm-button");
    await expect(confirm).toBeEnabled({ timeout: 15_000 });
    await confirm.click();
    await expect(row.locator('[data-tool="compound"]')).toHaveText("Confirming in wallet…");
    await expect(popup.getByTestId("compound-protocol-fee")).toBeVisible();
    // Closing the popup leaves the compound running; the row keeps its stage label.
    await popup.locator('button[aria-label="Close"]').first().click();
    await expect(popup).toHaveCount(0);
    await expectRowLayout(page, `confirming ${width}`, desktop);
    // From 1280 px the longest status label fits in full; narrower screens truncate it (the button's title keeps it).
    const label = row.locator('[data-tool="compound"] span');
    if (width >= 1280) expect(await label.evaluate((span) => span.scrollWidth <= span.clientWidth)).toBe(true);
    await expect(row.locator('[data-tool="compound"]')).toHaveAttribute("title", "Confirming in wallet…");
    await context.close();
  });
}

for (const width of [375, 1280]) {
  test(`popups are a ${width < 640 ? "bottom sheet" : "centered modal"} at ${width}px, and the row click opens the detail`, async ({ browser, baseURL }) => {
    const { context, page } = await setup(browser, baseURL, width);
    const row = raydiumRow(page);
    await row.locator('[data-tool="deposit"]').click();
    const add = page.locator('dialog[data-testid="deposit-popup"][data-open="true"]');
    await expect(add).toBeVisible();
    const box = (await add.boundingBox())!;
    const viewport = page.viewportSize()!;
    if (width < 640) {
      expect(Math.round(box.x)).toBe(0);
      expect(Math.round(box.width)).toBe(viewport.width);
      expect(Math.round(box.y + box.height)).toBe(viewport.height);
    } else {
      expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
      expect(box.y).toBeGreaterThan(0);
    }
    await page.keyboard.press("Escape");
    await expect(add).toHaveCount(0);
    // The row itself (outside its buttons) opens the Performance detail; keyboard reaches it through its title button.
    await row.getByTestId("position-row-title").click();
    await expect(page.locator('dialog[data-testid="performance-popup"][data-open="true"]')).toBeVisible();
    await expect(page).toHaveURL(/view=performance/);
    await page.keyboard.press("Escape");
    await row.getByTestId("position-fallback-select").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('dialog[data-testid="performance-popup"][data-open="true"]')).toBeVisible();
    await context.close();
  });
}
