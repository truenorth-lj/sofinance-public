// Read-only smoke against a deployed site (default https://sofinancelab.xyz). It never signs a transaction, never
// broadcasts, never prepares anything on the server: only page loads, a fake-wallet connect (public key only), a bad
// sign token (rejected by the server) and the public MCP tools/list.
import { expect, test } from "../../support/readonly-fixture";
import { ConnectModal } from "../../pages/connect-modal";

const EXPECTED_TOOLS = [
  "lp_withdraw_prepare", "lp_withdraw_submit",
  "position_get_performance", "position_get_range_status", "pools_list", "pool_get_range_apr", "positions_list",
  "lp_add_quote", "lp_add_prepare", "lp_compound_quote", "lp_compound_prepare",
  "lp_add_submit", "lp_compound_submit", "lp_open_quote", "lp_open_prepare", "lp_open_submit",
];

test.describe("production, read-only", () => {
  for (const path of ["/", "/app/portfolio", "/app/portfolio/recovery", "/app/rwa-pairs"]) {
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

  for (const [from, to] of [
    ["/app?smoke=1", "/app/portfolio?smoke=1"],
    ["/app/plan?smoke=1", "/app/rwa-pairs"],
    ["/app/position-performance?smoke=1", "/app/portfolio?smoke=1&view=performance"],
  ]) {
    test(`legacy ${from} declares its canonical redirect without following`, async ({ request, baseURL }) => {
      const response = await request.get(from!, { maxRedirects: 0, maxRetries: 0 });
      // Page redirects under the root Suspense boundary stream as 200; the
      // proxy redirect for /app remains an HTTP redirect. Neither is followed.
      if (from !== "/app?smoke=1") {
        expect(response.status()).toBe(200);
        expect((await response.text()).replaceAll("\\u0026", "&"))
          .toContain(`NEXT_REDIRECT;replace;${to};307;`);
        return;
      }
      expect(response.status()).toBe(307);
      const location = new URL(response.headers().location!, baseURL);
      const expected = new URL(to!, baseURL);
      expect(location.origin).toBe(expected.origin);
      expect(location.pathname).toBe(expected.pathname);
      expect([...location.searchParams].sort()).toEqual([...expected.searchParams].sort());
    });
  }

  test("J1: the injected wallet appears in the real AppKit modal and connects (public key only, no signature)", async ({ page, wallet }) => {
    await page.goto("/app/portfolio", { waitUntil: "domcontentloaded" });
    const modal = new ConnectModal(page, wallet);
    await modal.open();
    await expect(page.getByRole("button", { name: new RegExp(`${wallet.name}.*installed`, "i") })).toBeVisible();
    await modal.walletEntry.first().click();
    await expect(modal.navAddress).toBeVisible();
    // The homepage must restore this AppKit session without wallet-adapter's walletName hint.
    expect(await page.evaluate(() => localStorage.getItem("walletName"))).toBeNull();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const homeWallet = page.getByTestId("nav-solana-wallet");
    await expect(homeWallet).toHaveAttribute("data-connected", "true");
    await expect(homeWallet).toContainText(modal.shortAddress);
    await expect(page.getByTestId("w3m-modal-card")).not.toBeVisible();
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(homeWallet).toHaveAttribute("data-connected", "true");
    await expect(page.getByTestId("w3m-modal-card")).not.toBeVisible();
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
    const response = await request.post("/api/mcp", { maxRedirects: 0, maxRetries: 0, data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(response.status()).toBe(200);
    const body = await response.json() as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
  });

  test("MCP tools/call without a token is refused", async ({ request }) => {
    const response = await request.post("/api/mcp", { maxRedirects: 0, maxRetries: 0, data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "position_get_performance", arguments: {} } } });
    expect(response.status()).toBe(401);
    expect(response.headers()["www-authenticate"]).toBe('Bearer realm="sofinance-mcp"');
    expect((await response.json()).error.code).toBe(-32001);
  });
});
