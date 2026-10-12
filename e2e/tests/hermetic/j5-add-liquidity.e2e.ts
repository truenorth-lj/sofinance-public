import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";
import { randomAddress, buildSingleSignerTx } from "../../support/tx";
import type { Page } from "@playwright/test";
import type { FakeWallet } from "../../fake-wallet/node-signer";

async function setup(page: Page, wallet: FakeWallet, options: { prepareFails?: boolean; uncertainSend?: boolean } = {}) {
  const positionMint = randomAddress(), mintA = randomAddress(), mintB = randomAddress();
  const inputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const poolId = randomAddress(), positionAccount = randomAddress();
  const selection = { positionMint, inputMint, inputKind: "token" };
  const state = { wallet: wallet.address, ...selection, poolId, positionAccount,
    slot: 42, solLamports: 1_000_000_000, inputDecimals: 6, inputBalance: "200000311", inputAccount: randomAddress(), nftAta: randomAddress(),
    mintA, mintB, decimalsA: 6, decimalsB: 6, ownsNft: true, sufficientSol: true, unsupportedExtensions: [],
    paused: false, frozen: false, transferFee: false, rangeSide: "inside", inRange: true,
    price: "1", tickLower: -10, tickUpper: 10, liquidity: "100", currentAmounts: { a: "1000000", b: "1000000" },
    balances: { input: "200000311", a: "0", b: "0" }, fees: { a: "0", b: "0" }, rewards: [], eligible: true };
  const calls: string[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    calls.push(pathname);
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : {};
    const preview = { wallet: wallet.address, ...selection, poolId, positionAccount, inputDecimals: 6,
      requested: String(Math.round(Number(body.amount ?? "1") * 1e6)), floorBps: body.floorBps ?? 9900,
      toleranceBps: body.toleranceBps ?? 100, expiresAt: Date.now() + 75000, passesFloor: false,
      spendA: "500000", spendB: "500000", minOutA: "495000", minOutB: "495000", decimalsA: 6, decimalsB: 6,
      mintA, mintB, liquidity: "100", roundtripCostInput: null };
    let value: unknown = {};
    if (pathname === "/api/wallet") value = { wallet: wallet.address, slot: 1, fetchedAt: Date.now(),
      positions: [{ ...state, symbolA: "AAA", symbolB: "BBB", feeTierBps: 1, tickCurrent: 0 }],
      assets: [{ kind: "token", mint: inputMint, eligible: true, decimals: 6, balance: "200000311", totalBalance: "200000311", reason: null }] };
    if (pathname === "/api/selected-state" || pathname === "/api/compound-state") value = state;
    if (pathname === "/api/selected-quote") value = preview;
    if (pathname === "/api/selected-preflight") throw new Error("Automatic full preflight must not run");
    if (pathname === "/api/selected-prepare") {
      if (options.prepareFails) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Simulation failed" }) });
      const built = buildSingleSignerTx(wallet.address);
      value = { quote: preview, simulated: true, expiresAt: preview.expiresAt, permit: "test-permit",
        unsignedTransaction: built.b64, blockhash: built.tx.message.recentBlockhash,
        lastValidBlockHeight: 1000, startingLiquidity: state.liquidity, startingBalances: state.balances,
        simulatedSolDebitLamports: "5000" };
    }
    if (pathname === "/api/selected-broadcast") {
      if (options.uncertainSend) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Uncertain send" }) });
      const tx = await import("@solana/web3.js").then(({ VersionedTransaction }) =>
        VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64")));
      const bs58 = (await import("bs58")).default;
      value = { signature: bs58.encode(tx.signatures[0]!) };
    }
    if (pathname === "/api/selected-status") value = { status: "pending", state: null, signature: body.signature };
    if (pathname === "/api/beam-status") value = { beam: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
  await page.goto("/app?view=deposit");
  await new ConnectModal(page, wallet).connect();
  await page.getByRole("textbox", { name: "Input limit" }).fill("1");
  const add = page.getByRole("button", { name: "Add liquidity", exact: true });
  await expect(add).toBeEnabled();
  return { calls, add };
}

test("input enables Add after a lightweight preview; no automatic simulation or prepare", async ({ page, wallet }) => {
  const { calls } = await setup(page, wallet);
  await expect(page.getByText("Preview ready. Final checks run when you add liquidity.")).toBeVisible();
  expect(calls.filter((p) => p === "/api/selected-quote")).toHaveLength(1);
  expect(calls).not.toContain("/api/selected-preflight"); expect(calls).not.toContain("/api/selected-prepare");
  expect(wallet.ledger).toEqual([]);
  await expect(page.getByText("Checked when you add liquidity", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("add-preview-desktop.png") });
});

test("one Add prepares once, signs the same message, broadcasts once and persists pending", async ({ page, wallet }) => {
  const { calls, add } = await setup(page, wallet);
  await add.click();
  await expect.poll(() => calls.filter((p) => p === "/api/selected-broadcast").length).toBe(1);
  expect(calls.filter((p) => p === "/api/selected-prepare")).toHaveLength(1);
  expect(wallet.ledger).toHaveLength(1);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("add-pending.png") });
});

test("failed prepare never calls the wallet or broadcast", async ({ page, wallet, guards }) => {
  guards.allowConsole(/^Failed to load resource: the server responded with a status of 400/);
  const { calls, add } = await setup(page, wallet, { prepareFails: true });
  await add.click(); await expect(page.getByRole("alert").filter({ hasText: "Simulation failed" })).toBeVisible();
  expect(wallet.ledger).toEqual([]); expect(calls).not.toContain("/api/selected-broadcast");
});

test("wallet message mutation blocks broadcast", async ({ page, wallet }) => {
  wallet.mode = "mutate-message";
  const { calls, add } = await setup(page, wallet);
  await add.click(); await expect(page.getByRole("alert").filter({ hasText: "Wallet modified transaction content" })).toBeVisible();
  expect(calls).not.toContain("/api/selected-broadcast");
});

test("ambiguous send remains locked through reload and never auto-retries", async ({ page, wallet }) => {
  const { calls, add } = await setup(page, wallet, { uncertainSend: true });
  await add.click();
  await expect.poll(() => calls.filter((p) => p === "/api/selected-broadcast").length).toBe(1);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Signature exists, verifying on-chain status; do not resubmit").first()).toBeVisible();
  expect(calls.filter((p) => p === "/api/selected-broadcast")).toHaveLength(1);
});

test("mobile shows the same ready preview without overflow or signing", async ({ page, wallet }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { add } = await setup(page, wallet);
  await expect(add).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(wallet.ledger).toEqual([]);
  await page.screenshot({ path: test.info().outputPath("add-preview-mobile.png") });
});
