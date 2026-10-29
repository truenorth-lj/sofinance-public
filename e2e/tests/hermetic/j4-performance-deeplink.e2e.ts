// J4: Performance deep link /app?view=performance&mint=<position NFT> must never leave the exit estimate waiting forever
// when the connected wallet (or no wallet) cannot supply the position's NFT token account. Read-only: no signing, no
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
  test("no wallet connected: explains why and offers a manual preview instead of waiting forever", async ({ page, wallet }) => {
    const exitRequests = await mockPerformanceApis(page);
    await page.goto(`/app?view=performance&mint=${MINT}`, { waitUntil: "domcontentloaded" });
    const section = page.getByRole("region", { name: "Exit estimates" });
    await expect(section).toContainText("Connect that wallet, or preview this position manually");
    await expect(page.getByText("Waiting for position accounts…")).toHaveCount(0);
    expect(exitRequests).toHaveLength(0);

    await section.getByRole("button", { name: "Preview exit: USDC + SOL" }).click();
    await expect(section).toContainText("1.000000 USDC + 0.008580200 SOL");
    expect(exitRequests).toHaveLength(1);
    expect(exitRequests[0]!.searchParams.get("positionId")).toBe(MINT);
    expect(exitRequests[0]!.searchParams.has("nftAccount")).toBe(false);
    expect(wallet.ledger).toEqual([]);
  });

  test("connected wallet that holds no positions: same fallback after connecting", async ({ page, wallet }) => {
    const exitRequests = await mockPerformanceApis(page);
    await page.goto(`/app?view=performance&mint=${MINT}`, { waitUntil: "domcontentloaded" });
    const modal = new ConnectModal(page, wallet);
    await modal.connect();
    await expect(modal.navAddress).toBeVisible();
    const section = page.getByRole("region", { name: "Exit estimates" });
    await expect(section).toContainText("Connect that wallet, or preview this position manually");
    await expect(page.getByText("Waiting for position accounts…")).toHaveCount(0);
    expect(exitRequests).toHaveLength(0);
    expect(wallet.ledger).toEqual([]);
  });
});
