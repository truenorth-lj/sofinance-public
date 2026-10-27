// Read-only smoke against a deployed site (default https://sofinancelab.xyz). It never signs a transaction, never
// broadcasts, never prepares anything on the server: only page loads, a fake-wallet connect (public key only), a bad
// sign token (rejected by the server) and the public MCP tools/list.
import { expect, test as base } from "@playwright/test";
import { installFakeWallet } from "../../fake-wallet/install";
import { FakeWallet } from "../../fake-wallet/node-signer";
import { ConnectModal } from "../../pages/connect-modal";
import { stubWalletApis } from "../../support/guards";

const test = base.extend<{ wallet: FakeWallet }>({
  wallet: async ({}, use) => { await use(new FakeWallet()); },    // eslint-disable-line no-empty-pattern
  context: async ({ context, wallet }, use) => {
    await installFakeWallet(context, wallet);
    await stubWalletApis(context, wallet.address);                // keep a random address off the real wallet-scan route
    await use(context);
  },
});

const EXPECTED_TOOLS = [
  "prepare_withdraw", "submit_withdraw",
  "get_position_performance", "get_pool_activity", "get_position_range_status", "list_rwa_pairs", "list_positions",
  "quote_add_liquidity", "prepare_transaction", "quote_compound", "prepare_compound_transaction",
  "submit_signed_transaction", "submit_compound_transaction", "quote_open_position", "prepare_open_position", "submit_open_position",
];

test.describe("production, read-only", () => {
  for (const path of ["/", "/app", "/app/plan", "/app/rwa-pairs", "/app/position-performance"]) {
    test(`page ${path} loads (200) without page errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("navigation").or(page.locator("nav")).first()).toBeVisible();
      await page.waitForLoadState("load");
      expect(errors).toEqual([]);
    });
  }

  test("J1: the injected wallet appears in the real AppKit modal and connects (public key only, no signature)", async ({ page, wallet }) => {
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    const modal = new ConnectModal(page, wallet);
    await modal.open();
    await expect(page.getByRole("button", { name: new RegExp(`${wallet.name}.*installed`, "i") })).toBeVisible();
    await modal.walletEntry.first().click();
    await expect(modal.navAddress).toBeVisible();
    expect(wallet.ledger).toEqual([]);
  });

  test("J3 (server side): garbage and tampered sign tokens are rejected, nothing is signed", async ({ page, wallet }) => {
    for (const token of ["AAAA.BBBB", "justonepart"]) {
      await page.goto(`/app/sign/${token}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText("This sign token has expired or is invalid.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Sign and submit" })).toHaveCount(0);
    }
    expect(wallet.ledger).toEqual([]);
  });

  test("MCP tools/list is public and returns the 16 tools in order", async ({ request }) => {
    const response = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(response.status()).toBe(200);
    const body = await response.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
  });

  test("MCP tools/call without a token is refused", async ({ request }) => {
    const response = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_rwa_pairs", arguments: {} } } });
    expect(response.status()).toBe(401);
  });
});
