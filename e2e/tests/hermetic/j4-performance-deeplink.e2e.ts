// J4: Performance deep link /app?view=performance&mint=<position NFT> opens the report and never waits on an exit estimate
// (that moved to the Withdraw tool). Read-only: no signing, no
// broadcast. The server's performance / exit-preview answers are mocked (hermetic lane: no live RPC).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";

const sample = JSON.parse(readFileSync(fileURLToPath(new URL("../../../src/components/__fixtures__/position-performance-sample.json", import.meta.url)), "utf8"));
const MINT: string = sample.positionMint;
const exitBody = { status: "verified-preview", executable: false, sent: false, recoveryUSDCAtomic: "1000000", recoverySOLLamports: "8580200",
  networkAndPriorityLamports: "5000", observedAt: "2026-01-01T00:00:00.000Z", localExpiresAt: "2999-01-01T00:00:00.000Z", bytes: 1123 };

async function mockPerformanceApis(page: Page) {
  const exitRequests: URL[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/wallet" || url.pathname === "/api/token-metadata") return route.fallback();   // context-level stubs
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/position-performance") return json({ ...sample, positionMint: url.searchParams.get("positionMint") });
    if (url.pathname === "/api/lp-decision/exit-preview") { exitRequests.push(url); return json(exitBody); }
    if (url.pathname === "/api/pool-daily-apr") {
      return json({ poolId: url.searchParams.get("poolId"), label: "Pool", assumptions: "", feeRate: null,
        published: { dayFeeApr: null, weekFeeApr: null, monthFeeApr: null }, points: [], sources: [], fetchedAt: "2026-01-01T00:00:00.000Z" });
    }
    return json({});                                                                                       // anything else the page polls
  });
  return exitRequests;
}

test.describe("J4 performance deep link", () => {
  // The exit estimate now lives in the Withdraw tool (for a position this wallet holds), so the Performance deep link
  // shows the report only and never reads an exit estimate or waits for position accounts.
  test("no wallet connected: Performance opens without an exit estimate or a wait", async ({ page, wallet }) => {
    const exitRequests = await mockPerformanceApis(page);
    await page.goto(`/app?view=performance&mint=${MINT}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#performance-view")).toBeVisible();
    await expect(page.getByRole("region", { name: "Exit estimates" })).toHaveCount(0);
    await expect(page.getByText("Waiting for position accounts…")).toHaveCount(0);
    expect(exitRequests).toHaveLength(0);
    expect(wallet.ledger).toEqual([]);
  });

  test("connected wallet that holds no positions: same after connecting", async ({ page, wallet }) => {
    const exitRequests = await mockPerformanceApis(page);
    await page.goto(`/app?view=performance&mint=${MINT}`, { waitUntil: "domcontentloaded" });
    const modal = new ConnectModal(page, wallet);
    await modal.connect();
    await expect(modal.navAddress).toBeVisible();
    await expect(page.locator("#performance-view")).toBeVisible();
    await expect(page.getByRole("region", { name: "Exit estimates" })).toHaveCount(0);
    await expect(page.getByText("Waiting for position accounts…")).toHaveCount(0);
    expect(exitRequests).toHaveLength(0);
    expect(wallet.ledger).toEqual([]);
  });
});
