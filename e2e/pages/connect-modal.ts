import { expect, type Page } from "@playwright/test";
import type { FakeWallet } from "../fake-wallet/node-signer";

/** Works for both providers: Reown AppKit modal (production) and the wallet-adapter modal (no project id). */
export class ConnectModal {
  constructor(private readonly page: Page, private readonly wallet: FakeWallet) {}

  get connectButtons() { return this.page.getByRole("button", { name: /^connect wallet$/i }); }
  get walletEntry() { return this.page.getByRole("button", { name: new RegExp(this.wallet.name, "i") }); }
  /** Short form shown by the nav once connected: first 4 + … + last 4 (src/components/ink InkNav). */
  get shortAddress() { return `${this.wallet.address.slice(0, 4)}…${this.wallet.address.slice(-4)}`; }
  get navAddress() { return this.page.getByRole("button", { name: this.shortAddress, exact: true }).first(); }

  async open() {
    await this.connectButtons.first().click();
    const terms = this.page.getByRole("dialog", { name: "Before you connect", exact: true });
    await expect(terms.or(this.walletEntry.first())).toBeVisible();
    if (await terms.isVisible()) {
      await terms.getByRole("checkbox").check();
      await terms.getByRole("button", { name: "Continue to wallet", exact: true }).click();
    }
    await expect(this.walletEntry.first()).toBeVisible();
  }

  async connect() {
    await this.open();
    await this.walletEntry.first().click();
  }
}
