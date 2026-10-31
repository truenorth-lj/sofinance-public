import { expect, type Page, type Route } from "@playwright/test";
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import { FakeWallet } from "../fake-wallet/node-signer";
import type { SignKind } from "../support/sign-token";

/** Every kind relays through the shared pipeline's one-shot send route (the fake wallet has no signAndSend). */
export const BROADCAST_PATH: Record<SignKind, string> = {
  "add-liquidity": "**/api/tx-send",
  "open-position": "**/api/tx-send",
  compound: "**/api/tx-send",
};

export type BroadcastCall = { kind: SignKind; body: Record<string, unknown> };

export class SignPage {
  readonly broadcasts: BroadcastCall[] = [];
  constructor(private readonly page: Page) {}

  get signButton() { return this.page.getByRole("button", { name: "Sign and submit" }); }
  get connectButton() { return this.page.getByRole("button", { name: "Connect wallet" }).last(); }
  get disconnectButton() { return this.page.getByRole("button", { name: "Disconnect wallet" }); }
  /** The status line (first <p> in the card). */
  get status() { return this.page.locator("main p, p").filter({ hasText: /./ }).first(); }

  async goto(token: string) {
    await this.page.goto(`/app/sign/${token}`, { waitUntil: "domcontentloaded" });
  }

  /**
   * Mocks the broadcast route of `kind` (no transaction ever reaches a network in this lane).
   * Default behaviour = a well-behaved server: verifies the wallet signature of what the page posted and echoes its signature.
   */
  async mockBroadcast(kind: SignKind, behaviour: "ok" | "sent-false" | "server-error" | "wrong-signature" = "ok") {
    await this.page.route(BROADCAST_PATH[kind], async (route: Route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      this.broadcasts.push({ kind, body });
      if (behaviour === "sent-false") {
        return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "E2E mock: blocked", sent: false }) });
      }
      if (behaviour === "server-error") {
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "E2E mock: upstream exploded" }) });
      }
      const tx = VersionedTransaction.deserialize(Buffer.from(String(body.signedTransaction), "base64"));
      const signature = behaviour === "wrong-signature" ? bs58.encode(new Uint8Array(64).fill(7)) : bs58.encode(tx.signatures[0]!);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ signature }) });
    });
  }

  /** Decodes the transaction the page posted and returns whether signature `index` verifies for `address`. */
  signatureVerifies(call: BroadcastCall, address: string, index = 0): boolean {
    const tx = VersionedTransaction.deserialize(Buffer.from(String(call.body.signedTransaction), "base64"));
    return FakeWallet.verify(address, tx.message.serialize(), tx.signatures[index]!);
  }

  async expectStatus(text: string | RegExp) {
    await expect(this.page.getByText(text).first()).toBeVisible();
  }
}
