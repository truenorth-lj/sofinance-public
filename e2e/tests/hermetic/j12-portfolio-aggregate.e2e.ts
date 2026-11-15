// Portfolio figures use one compact aggregate; detailed performance remains on demand.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";
const sample = JSON.parse(readFileSync(fileURLToPath(new URL("../../../src/components/__fixtures__/position-performance-sample.json", import.meta.url)), "utf8"));
const mints = [sample.positionMint as string, "So11111111111111111111111111111111111111112"];

test("aggregates two rows once, refreshes partial totals, and reads details only when opened", async ({ page, wallet }) => {
  let partial = false;
  const aggregateRequests: { positions: { key: string }[]; fresh: boolean }[] = [];
  let detailRequests = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/wallet") return json({ wallet: wallet.address, slot: 1, fetchedAt: Date.now(), assets: [], positions: mints.map((positionMint) => ({
      positionMint, positionAccount: positionMint, poolId: sample.poolId, mintA: sample.mintA, mintB: sample.mintB,
      symbolA: "SPCXx", symbolB: "SPCX", decimalsA: 8, decimalsB: 8, feeTierBps: 1,
      tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide: "inside", liquidity: "1",
    })) });
    if (url.pathname === "/api/portfolio") {
      const body = route.request().postDataJSON() as typeof aggregateRequests[number];
      aggregateRequests.push(body);
      return json({ wallet: wallet.address, positions: body.positions.map(({ key }, index) => ({ key,
        status: partial && index === 1 ? "failed" : "ready", figures: partial && index === 1
          ? { stock: null, shares: null, valueUsd: null, unclaimedFeesUsd: null, cumulativeFeesUsd: null }
          : { stock: "SPCX", shares: index + 1, valueUsd: 100 * (index + 1), unclaimedFeesUsd: index + 1, cumulativeFeesUsd: 10 * (index + 1) },
        evaluatedAt: "2026-11-15T00:00:00Z", historyComplete: !(partial && index === 1), historyRefreshResolved: true,
      })) });
    }
    if (url.pathname === "/api/position-performance") { detailRequests++; return json({ ...sample, positionMint: url.searchParams.get("positionMint") }); }
    if (url.pathname === "/api/token-metadata") return json({});
    if (url.pathname.endsWith("/positions")) return json({ positions: [] });
    if (url.pathname === "/api/pool-daily-apr") return json({ poolId: sample.poolId, label: "Pool", assumptions: "", published: { dayFeeApr: null, weekFeeApr: null, monthFeeApr: null }, points: [], sources: [], fetchedAt: "2026-01-01T00:00:00Z" });
    return json({});
  });
  await page.goto("/app/portfolio", { waitUntil: "domcontentloaded" });
  const modal = new ConnectModal(page, wallet);
  await modal.connect();
  await expect(modal.navAddress).toBeVisible();
  await expect(page.getByTestId("position-row")).toHaveCount(2);
  await expect(page.getByTestId("portfolio-total-value").locator("p").first()).toHaveText("$300.00");
  expect(aggregateRequests).toHaveLength(1);
  expect(aggregateRequests[0]!.positions.map((item) => item.key)).toEqual(mints.map((mint) => `raydium-clmm:${mint}`));
  expect(detailRequests).toBe(0);
  partial = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByTestId("portfolio-total-value").locator("p").first()).toHaveText("$100.00");
  await expect(page.getByText("Some values are unavailable for 1 position; totals include available values only.")).toBeVisible();
  expect(aggregateRequests).toHaveLength(2); expect(aggregateRequests[1]!.fresh).toBe(true);
  await page.getByTestId("position-fallback-select").first().click();
  await expect(page.locator('dialog[data-testid="performance-popup"][data-open="true"]')).toBeVisible();
  await expect.poll(() => detailRequests).toBe(1);
  expect(wallet.ledger).toEqual([]);
});

test("renders stored fees while updating, polls once, and stops when history is fresh", async ({ page, wallet }) => {
  await page.clock.install();
  const barrier = "2026-11-15T00:01:00Z";
  const requests: { fresh: boolean; positions: { key: string; refreshAfter?: string }[] }[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/wallet") return json({ wallet: wallet.address, slot: 1, fetchedAt: Date.now(), assets: [], positions: [{
      positionMint: mints[0], positionAccount: mints[0], poolId: sample.poolId, mintA: sample.mintA, mintB: sample.mintB,
      symbolA: "SPCXx", symbolB: "SPCX", decimalsA: 8, decimalsB: 8, feeTierBps: 1,
      tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide: "inside", liquidity: "1",
    }] });
    if (path === "/api/portfolio") {
      const body = route.request().postDataJSON() as typeof requests[number]; requests.push(body);
      const updating = requests.length === 1;
      return json({ wallet: wallet.address, positions: [{ key: body.positions[0]!.key, status: "ready",
        figures: { stock: "SPCX", shares: 1, valueUsd: 100, unclaimedFeesUsd: 1, cumulativeFeesUsd: updating ? 10 : 12 },
        evaluatedAt: barrier, historyComplete: true, historyRefreshResolved: !updating,
        historyUpdatedAt: updating ? "2026-11-15T00:00:00Z" : barrier,
        historyStatus: updating ? "updating" : "fresh", historyRefreshAfter: barrier,
      }] });
    }
    if (path.endsWith("/positions")) return json({ positions: [] });
    return json({});
  });
  await page.goto("/app/portfolio", { waitUntil: "domcontentloaded" });
  const modal = new ConnectModal(page, wallet); await modal.connect();
  await expect(page.getByTestId("portfolio-total-value").locator("p").first()).toHaveText("$100.00");
  await expect(page.getByTestId("portfolio-cumulative-fees").locator("p").first()).toHaveText("$10.00");
  await expect(page.getByTestId("portfolio-history-status")).toContainText("Updating fee history");
  expect(requests).toHaveLength(1);
  await page.clock.fastForward(8_000);
  await expect(page.getByTestId("portfolio-cumulative-fees").locator("p").first()).toHaveText("$12.00");
  await expect(page.getByTestId("portfolio-history-status")).not.toContainText("Updating");
  await expect(page.getByTestId("portfolio-history-status").locator("time")).toHaveAttribute("datetime", barrier);
  expect(requests[1]).toMatchObject({ fresh: false, positions: [{ key: `raydium-clmm:${mints[0]}`, refreshAfter: barrier }] });
  await page.clock.fastForward(60_000);
  expect(requests).toHaveLength(2); expect(wallet.ledger).toEqual([]);
});
