// J9: nothing scrolls sideways on a 360 px phone (the narrowest common Android width; wallet in-app browsers are
// 360-430 px), and no text field is small enough to make iOS zoom in on focus. Every public page, every /app view for
// a Raydium and a Meteora position, the input asset picker, the details dialog and the open-position modals.
// Hermetic: API answers come from e2e/support/layout-mocks.ts and every other host is blocked. Nothing is signed.
//
// LAYOUT_WIDTHS=360,375,390,1280 LAYOUT_SHOTS=/some/dir also saves a screenshot of each state (local review only);
// LAYOUT_TEXT_SCALE=125 enlarges the root font like a phone's large-text setting.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { installFakeWallet } from "../../fake-wallet/install";
import { FakeWallet } from "../../fake-wallet/node-signer";
import { ConnectModal } from "../../pages/connect-modal";
import { expectFitsScreen } from "../../support/layout-check";
import { installLayoutMocks } from "../../support/layout-mocks";

const widths = (process.env.LAYOUT_WIDTHS ?? "360").split(",").map(Number);
const shots = process.env.LAYOUT_SHOTS;
// Only routes that exist in production: /app/meteora and /app/rhc are behind server flags (404 / redirect when off).
const PAGES = ["/", "/app", "/app/rwa-pairs", "/app/plan", "/app/ai", "/app/position-performance",
  "/docs", "/docs/fees", "/docs/fee-apr", "/docs/risks", "/docs/security", "/docs/withdraw", "/blog", "/blog/dex-evolution",
  "/faq", "/terms"];

async function setup(browser: Browser, baseURL: string | undefined, width: number) {
  const phone = width < 640;
  const context = await browser.newContext({ baseURL, viewport: { width, height: 780 }, isMobile: phone, hasTouch: phone, reducedMotion: "reduce" });
  const origin = new URL(baseURL ?? "http://localhost").origin;
  await context.route((url) => url.origin !== origin, (route) => route.abort());
  const wallet = new FakeWallet({ mode: "reject" });
  await installFakeWallet(context, wallet);
  await installLayoutMocks(context, wallet.address);
  const scale = process.env.LAYOUT_TEXT_SCALE;
  if (scale) await context.addInitScript((pct) => document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = `html { font-size: ${pct}% !important; }`;
    document.head.append(style);
  }), scale);
  return { context, wallet, page: await context.newPage(), phone };
}

function checker(page: Page, width: number, phone: boolean) {
  return async (name: string, { fullPage = true }: { fullPage?: boolean } = {}) => {
    await page.waitForLoadState("networkidle").catch(() => {});
    await expectFitsScreen(page, `${name} at ${width}px`, { phone });
    if (shots) await page.screenshot({ path: `${shots}/${process.env.LAYOUT_TEXT_SCALE ? `text${process.env.LAYOUT_TEXT_SCALE}-` : ""}${name}-${width}.png`, fullPage });
  };
}

for (const width of widths) {
  test.describe(`J9 layout at ${width}px`, () => {
    test("public pages and the app menu", async ({ browser, baseURL }) => {
      test.setTimeout(180_000);
      const { context, page, phone } = await setup(browser, baseURL, width);
      const check = checker(page, width, phone);
      for (const path of PAGES) {
        const response = await page.goto(path, { waitUntil: "domcontentloaded" });
        expect.soft(response?.status(), `${path} should be a real page, not a 404`).toBeLessThan(400);
        await page.locator("main, h1").first().waitFor();
        await check(path === "/" ? "home" : path.slice(1).replaceAll("/", "-"));
      }
      if (phone) {
        await page.goto("/app", { waitUntil: "domcontentloaded" });
        await page.getByTestId("nav-menu").click();
        await page.getByRole("navigation", { name: "App" }).getByRole("link").first().waitFor();
        await check("app-menu-open", { fullPage: false });
        await page.keyboard.press("Escape");
        await page.locator("footer").getByRole("link", { name: "Docs", exact: true }).waitFor({ state: "attached" });
      }
      await context.close();
    });

    test("every /app view, the input asset picker and the details dialog", async ({ browser, baseURL }) => {
      test.setTimeout(180_000);
      const { context, page, wallet, phone } = await setup(browser, baseURL, width);
      const check = checker(page, width, phone);
      await page.goto("/app", { waitUntil: "domcontentloaded" });
      await new ConnectModal(page, wallet).connect();
      await page.getByText("Price within range").first().waitFor();
      const show = async (view: string) => {
        if (phone) await page.locator("#position-action").selectOption(view);
        else {
          const values = await page.locator("#position-action option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
          await page.getByRole("navigation", { name: "Position operations" }).getByRole("button").nth(values.indexOf(view)).click();
        }
      };
      const views = () => page.locator("#position-action option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
      const positions = await page.locator("#position option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value).filter(Boolean));
      for (const position of positions) {
        await page.locator("#position").selectOption(position);
        await page.getByText(/^(Price within range|In range)$/).first().waitFor();
        const source = position.startsWith("meteora") ? "meteora" : "raydium";
        for (const view of await views()) {
          await show(view);
          await check(`app-${source}-${view}`);
          if (view === "deposit" && source === "raydium") {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await check("app-raydium-deposit-bottom", { fullPage: false });
            await page.locator("button[aria-labelledby=asset-label]").first().click();
            await page.getByRole("dialog", { name: /input asset/i }).waitFor();
            await check("app-input-asset-picker", { fullPage: false });
            await page.keyboard.press("Escape");
          }
        }
      }
      await page.getByRole("button", { name: "Learn more details" }).click();
      await check("app-details-dialog", { fullPage: false });
      await context.close();
    });

    test("pool list, cards, the terms gate and the open-position modals", async ({ browser, baseURL }) => {
      test.setTimeout(180_000);
      const { context, page, wallet, phone } = await setup(browser, baseURL, width);
      const check = checker(page, width, phone);
      await page.goto("/app/rwa-pairs", { waitUntil: "domcontentloaded" });
      const open = page.getByRole("button", { name: /^Open position in / });
      await open.first().waitFor();
      await check("rwa-pairs-cards");
      // "Calculate shares" dialog (PR #312): fits the screen and every field is 16 px+ on phones, also scrolled to the end.
      const calc = page.getByRole("button", { name: /^Calculate( shares)? for / }).first();
      await calc.waitFor();
      await calc.click();
      const calcDialog = page.getByRole("dialog", { name: /^Calculate( shares)? for / });
      await calcDialog.waitFor();
      await check("calc-shares-dialog", { fullPage: false });
      await calcDialog.evaluate((el) => { el.scrollTop = el.scrollHeight; el.querySelectorAll("*").forEach((c) => { c.scrollTop = c.scrollHeight; }); });
      await check("calc-shares-dialog-bottom", { fullPage: false });
      await calcDialog.getByRole("button", { name: "Close", exact: true }).click();
      await calcDialog.waitFor({ state: "hidden" });
      const list = page.getByRole("button", { name: "List", exact: true });
      if (await list.count()) {
        await list.first().click();
        await check("rwa-pairs-list");
        await page.getByRole("button", { name: "Cards", exact: true }).first().click();
      }
      await open.first().click();                                   // not connected yet: the terms gate comes first
      await page.getByRole("dialog", { name: "Before you connect", exact: true }).waitFor();
      await check("terms-gate", { fullPage: false });
      await page.goto("/app", { waitUntil: "domcontentloaded" });
      const connect = new ConnectModal(page, wallet);
      await connect.connect();
      await connect.navAddress.waitFor();
      // In-app navigation keeps the wallet session (a full reload may ask to connect again).
      if (phone) await page.getByTestId("nav-menu").click();
      await page.getByRole("navigation", { name: "App" }).getByRole("link", { name: "Pools" }).click();
      await open.first().waitFor();
      // Raydium (INTC), both SPCX pools (Raydium and Meteora DLMM) and a Robinhood Chain pool (TSLA/TSLAon).
      // The Raydium modals must also close on Escape; the others use their Close button here.
      const targets: [string, number, "Escape" | "Close"][] = [["INTCx/INTC", 0, "Escape"], ["SPCXx/SPCX", 0, "Escape"], ["SPCXx/SPCX", 1, "Close"], ["TSLA/TSLAon", 0, "Close"]];
      for (const [pair, nth, close] of targets) {
        await page.getByRole("button", { name: `Open position in ${pair}`, exact: true }).nth(nth).click();
        const dialog = page.getByRole("dialog").first();
        await dialog.waitFor();
        await check(`open-modal-${pair.replace("/", "-")}-${nth + 1}`, { fullPage: false });
        if (close === "Escape") await page.keyboard.press("Escape");
        else await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
      }
      await context.close();
    });
  });
}
