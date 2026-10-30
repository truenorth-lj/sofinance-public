// J1: connect a (fake) wallet through the real provider UI on /app: modal lists the wallet, connect, short address,
// no signing requested by connecting, reload behaviour, disconnect, reconnect.
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";

const appkit = process.env.E2E_PROVIDER !== "adapter";

test.describe("J1 connect wallet", () => {
  test("lists the injected wallet, connects, shows the short address, asks for no signature", async ({ page, wallet }) => {
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    const modal = new ConnectModal(page, wallet);
    await expect(modal.navAddress).toHaveCount(0);

    await modal.open();
    if (appkit) await expect(page.getByRole("button", { name: new RegExp(`${wallet.name}.*installed`, "i") })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("j1-modal.png") });

    await modal.walletEntry.first().click();
    await expect(modal.navAddress).toBeVisible();
    await expect(modal.connectButtons).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("j1-connected.png") });
    // Connecting must never request a signature (only an explicit user action may).
    expect(wallet.ledger).toEqual([]);
  });

  test("disconnect clears the session, and the wallet can be connected again", async ({ page, wallet }) => {
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    const modal = new ConnectModal(page, wallet);
    await modal.connect();
    await expect(modal.navAddress).toBeVisible();

    await modal.navAddress.click();                                  // the nav address button disconnects
    await expect(modal.navAddress).toHaveCount(0);
    await expect(modal.connectButtons.first()).toBeVisible();

    await modal.connect();
    await expect(modal.navAddress).toBeVisible();
    expect(wallet.ledger).toEqual([]);
  });

  test("reload persistence (observed behaviour is pinned per provider)", async ({ page, wallet }) => {
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    const modal = new ConnectModal(page, wallet);
    await modal.connect();
    await expect(modal.navAddress).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    if (appkit) {
      // AppKit auto-reconnects the Wallet Standard wallet after a reload.
      await expect(modal.navAddress).toBeVisible();
    } else {
      // wallet-adapter: record whatever happens (discovery); the test only requires a settled UI.
      await expect(modal.navAddress.or(modal.connectButtons.first())).toBeVisible();
      test.info().annotations.push({ type: "adapter-reload", description: (await modal.navAddress.count()) ? "reconnected" : "disconnected" });
    }
    expect(wallet.ledger).toEqual([]);
  });

  test("a wallet that is not installed is not offered (modal lists only WalletConnect)", async ({ page, wallet }) => {
    test.skip(!appkit, "AppKit-specific modal layout");
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    await new ConnectModal(page, wallet).open();
    await expect(page.getByRole("button", { name: /phantom/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /solflare/i })).toHaveCount(0);
  });
});
