import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";
import { randomAddress, buildSingleSignerTx } from "../../support/tx";
import type { FakeWallet } from "../../fake-wallet/node-signer";

type Reply = { status: "pending" | "success" | "failed" | "expired" | "manual-review";
  chainStatus?: "pending" | "success" | "failed" | "expired" | "unknown"; signature?: string };

/** API answers and keys are synthetic. No funded wallet or mainnet send enters this lane. */
async function setup(page: Page, wallet: FakeWallet, reply: Reply, otherWalletRecord = false) {
  const positionMint = randomAddress(), oldMint = randomAddress(), mintA = randomAddress(), mintB = randomAddress();
  const inputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const poolId = randomAddress(), positionAccount = randomAddress();
  const selection = { positionMint, inputMint, inputKind: "token" };
  const state = { wallet: wallet.address, ...selection, poolId, positionAccount, programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    slot: 42, solLamports: 1_000_000_000, inputDecimals: 6, inputBalance: "200000311", inputAccount: randomAddress(), nftAta: randomAddress(),
    mintA, mintB, decimalsA: 6, decimalsB: 6, ownsNft: true, sufficientSol: true, unsupportedExtensions: [],
    paused: false, frozen: false, transferFee: false, rangeSide: "inside", inRange: true,
    price: "1", tickLower: -10, tickUpper: 10, liquidity: "100", currentAmounts: { a: "1000000", b: "1000000" },
    balances: { input: "200000311", a: "0", b: "0" }, fees: { a: "10", b: "20" }, rewards: [], eligible: true,
    vaultA: randomAddress(), vaultB: randomAddress() };
  const recordWallet = otherWalletRecord ? randomAddress() : wallet.address;
  const accounts = [mintA, mintB].map((mint, index) => ({ mint, seed: String(index).repeat(22), address: randomAddress(),
    program: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", space: 165, rentLamports: 2039280 }));
  const createdAt = Date.now();
  const attempt = { version: 1, kind: "compound", wallet: recordWallet, positionMint: oldMint, signature: bs58.encode(new Uint8Array(64).fill(42)), createdAt,
    summary: { operation: "compound", simulated: true, state: { ...state, wallet: recordWallet, positionMint: oldMint }, positionMint: oldMint, positionAccount, poolId,
      compoundAccounts: accounts, blockhash: randomAddress(), lastValidBlockHeight: 150, expiresAt: createdAt + 75000,
      liquidity: "100", startingLiquidity: "100", amountMaxA: "10", amountMaxB: "20", simulatedEndingLiquidity: "200",
      simulatedDustA: "0", simulatedDustB: "0", simulatedSolDebitLamports: "5000", maxSolDebitLamports: "5000000",
      simulatedHarvest: { a: "10", b: "20" }, simulatedRewards: [], feeLamports: 5000, rentLamports: 4078560, swaps: [], priorSources: [] } };
  const attemptKey = `sofinance:compound:v1:${recordWallet}`, receiptsKey = `sofinance:compound-receipts:v1:${recordWallet}`;
  await page.addInitScript(({ attemptKey, receiptsKey, attempt }) => {
    if (localStorage.getItem(attemptKey) === null) {
      localStorage.setItem(attemptKey, JSON.stringify(attempt));
      localStorage.setItem(receiptsKey, JSON.stringify([{ wallet: attempt.wallet, positionMint: attempt.positionMint,
        sourceSignature: attempt.signature, compoundAccounts: attempt.summary.compoundAccounts }]));
    }
  }, { attemptKey, receiptsKey, attempt });
  const calls: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()), path = url.pathname;
    calls.push(path);
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : {};
    const currentMint = body.positionMint ?? url.searchParams.get("positionMint") ?? positionMint;
    const quote = { wallet: wallet.address, ...selection, positionMint: currentMint, poolId, positionAccount, inputDecimals: 6,
      requested: String(Math.round(Number(body.amount ?? "1") * 1e6)), floorBps: body.floorBps ?? 9900,
      toleranceBps: body.toleranceBps ?? 100, expiresAt: Date.now() + 75000, passesFloor: false,
      spendA: "500000", spendB: "500000", minOutA: "495000", minOutB: "495000", decimalsA: 6, decimalsB: 6,
      mintA, mintB, liquidity: "100", roundtripCostInput: null };
    let value: unknown = {};
    if (path === "/api/wallet") value = { wallet: wallet.address, slot: 1, fetchedAt: Date.now(),
      positions: [positionMint, oldMint].map((mint) => ({ ...state, positionMint: mint, symbolA: "AAA", symbolB: "BBB", feeTierBps: 1, tickCurrent: 0 })),
      assets: [{ kind: "token", mint: inputMint, eligible: true, decimals: 6, balance: "200000311", totalBalance: "200000311", reason: null }] };
    if (path === "/api/selected-state" || path === "/api/compound-state") value = { ...state, positionMint: currentMint };
    if (path === "/api/selected-quote") value = quote;
    if (path === "/api/compound-confirm") value = { signature: attempt.signature, state: null, ...reply };
    if (path === "/api/selected-preflight") throw new Error("Automatic preflight must not run");
    if (path === "/api/selected-prepare") {
      const built = buildSingleSignerTx(wallet.address);
      value = { quote, simulated: true, expiresAt: quote.expiresAt, permit: "test-permit", unsignedTransaction: built.b64,
        blockhash: built.tx.message.recentBlockhash, lastValidBlockHeight: 1000, startingLiquidity: state.liquidity, startingBalances: state.balances };
    }
    if (/broadcast$/.test(path)) throw new Error("This journey must never broadcast");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
  await page.goto("/app?view=deposit");
  const modal = new ConnectModal(page, wallet);
  await modal.connect(); await expect(modal.navAddress).toBeVisible();
  await page.getByRole("textbox", { name: "Input limit" }).fill("1");
  await expect(page.getByText("Estimated liquidity added", { exact: true })).toBeVisible();
  return { calls, oldMint, attemptKey, receiptsKey, attempt,
    add: page.getByRole("button", { name: "Add liquidity", exact: true }), setReply: (next: Reply) => { reply = next; } };
}

async function showCompound(page: Page) {
  const mobileView = page.getByRole("combobox", { name: "Position operations", exact: true });
  if (await mobileView.isVisible()) await mobileView.selectOption("compound");
  else await page.getByRole("button", { name: "Yield Compound", exact: true }).click();
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`fresh harvest replaces the compound simulation before cleanup at ${viewport.width}px`, async ({ page, wallet, guards }) => {
    await page.setViewportSize(viewport);
    guards.allowConsole(/^Failed to load resource: the server responded with a status of 400/);
    const flow = await setup(page, wallet, { status: "success", chainStatus: "success" });
    await page.getByRole("combobox", { name: "Select Raydium position" }).selectOption(flow.oldMint);
    const freshState = { ...flow.attempt.summary.state, fees: { a: "0", b: "2" } };
    let compounded = false;
    await page.route("**/api/compound-state", route => route.fulfill({ json: compounded ? freshState : flow.attempt.summary.state }));
    await page.route("**/api/compound-prepare", route => {
      const built = buildSingleSignerTx(wallet.address);
      return route.fulfill({ json: { permit: "test-permit", unsignedTransaction: built.b64,
        summary: { ...flow.attempt.summary, blockhash: built.tx.message.recentBlockhash, expiresAt: Date.now() + 75000 } } });
    });
    await page.route("**/api/compound-broadcast", route => {
      const tx = VersionedTransaction.deserialize(Buffer.from(route.request().postDataJSON().signedTransaction, "base64"));
      compounded = true;
      return route.fulfill({ json: { signature: bs58.encode(tx.signatures[0]!) } });
    });
    await page.route("**/api/compound-confirm", route => route.fulfill({ json: {
      signature: route.request().postDataJSON().attempt.signature, status: "success", chainStatus: "success", state: compounded ? freshState : null,
    } }));
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    await page.route("**/api/compound-recover-prepare", async route => {
      await cleanup;
      await route.fulfill({ status: 400, json: { error: "Cleanup stopped for test" } });
    });
    await showCompound(page);
    const panel = page.getByRole("region", { name: "Yield Compound", exact: true });
    const harvest = panel.getByRole("region", { name: "Harvest", exact: true }).first();
    await expect(harvest).toContainText(/0\.00001 \S+ \+ 0\.00002 \S+/);
    await panel.getByRole("button", { name: "One-click compound", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Preparing cleanup…", exact: true })).toBeVisible();
    await expect(harvest).toContainText(/0 \S+ \+ 0\.000002 \S+/);
    await expect(panel.getByText("Compound confirmed on-chain", { exact: true })).toBeVisible();
    finishCleanup();
    await expect(panel.getByText("Cleanup paused.", { exact: false }).first()).toBeVisible();
    await expect(harvest).toContainText(/0 \S+ \+ 0\.000002 \S+/);
    expect(wallet.signedTransactions).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
  test(`other-position recovery failures remain visible beside their receipt at ${viewport.width}px`, async ({ page, wallet, guards }) => {
    await page.setViewportSize(viewport);
    guards.allowConsole(/^Failed to load resource: the server responded with a status of 400/);
    const flow = await setup(page, wallet, { status: "success", chainStatus: "success" });
    await page.route("**/api/compound-recover-prepare", route => route.fulfill({ status: 400, contentType: "application/json",
      body: JSON.stringify({ error: "Recovery simulation failed" }) }));
    await showCompound(page);
    await page.locator("summary").filter({ hasText: "Yield account management" }).click();
    await page.locator("summary").filter({ hasText: "Other positions (1 records)" }).click();
    await page.getByRole("button", { name: "Retrieve this balance", exact: true }).click();
    const alert = page.getByRole("region", { name: "Yield Compound", exact: true }).getByRole("alert");
    await expect(alert).toBeVisible(); await expect(alert).toHaveText("Recovery simulation failed");
    expect(await alert.evaluate(node => node.closest("details")?.querySelector("summary")?.textContent)).toBe("Other positions (1 records)");
    expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), flow.receiptsKey))!)).toHaveLength(1);
    expect(wallet.ledger).toEqual([]);
    expect(flow.calls.some(path => /broadcast$/.test(path))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
  test(`compound history and recovery records stay scoped to the selected NFT at ${viewport.width}px`, async ({ page, wallet, guards }) => {
    await page.setViewportSize(viewport);
    guards.allowConsole(/^Failed to load resource: the server responded with a status of 400/);
    const flow = await setup(page, wallet, { status: "success", chainStatus: "success" });
    await page.route("**/api/compound-prepare", route => route.fulfill({ status: 400, contentType: "application/json",
      body: JSON.stringify({ error: "Complete compound transaction 1268 bytes, exceeds 1,232 byte limit; no transaction was sent" }) }));
    await showCompound(page);
    const compoundPanel = page.getByRole("region", { name: "Yield Compound", exact: true });
    const management = page.locator("summary").filter({ hasText: "Yield account management" });
    const success = page.getByText("Compound confirmed on-chain", { exact: true });
    await expect(management).toContainText("0 records for this position");
    await expect(success).toBeHidden();
    await page.getByRole("button", { name: "One-click compound", exact: true }).click();
    await expect(compoundPanel.getByRole("alert")).toContainText("1268 bytes");
    await expect(success).toBeHidden();
    expect(wallet.ledger).toEqual([]);
    expect(flow.calls.some(path => /broadcast$/.test(path))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`compound-error-scoped-${viewport.width}.png`), fullPage: true });
    await management.click();
    await page.locator("summary").filter({ hasText: "Previous transaction for another position" }).click();
    await expect(success).toBeVisible();
    await page.locator("summary").filter({ hasText: "Other positions (1 records)" }).click();
    await expect(page.getByRole("button", { name: "Retrieve this balance" })).toBeVisible();
    await page.getByRole("combobox", { name: "Select Raydium position" }).selectOption(flow.oldMint);
    await expect(management).toContainText("1 records for this position");
    await expect(compoundPanel.getByRole("alert")).toBeHidden();
    await expect(success).toBeVisible();
    await expect(page.locator("summary").filter({ hasText: "Other positions (1 records)" })).toHaveCount(0);
    await page.getByRole("button", { name: "One-click compound", exact: true }).click();
    await expect(compoundPanel.getByRole("alert")).toContainText("1268 bytes");
    await expect(success).toBeHidden();
    await page.locator("summary").filter({ hasText: "Previous on-chain transaction" }).click();
    await page.getByRole("button", { name: "Requery on-chain result" }).click();
    await expect(compoundPanel.getByRole("alert")).toContainText("1268 bytes");
    expect(wallet.ledger).toEqual([]);
  });
  test(`finalized receipt warning permits add and final prepare at ${viewport.width}px`, async ({ page, wallet }) => {
    await page.setViewportSize(viewport); wallet.mode = "reject";
    const flow = await setup(page, wallet, { status: "manual-review", chainStatus: "success" });
    await expect(flow.add).toBeEnabled();
    const warning = page.getByText(/yield details need verification/);
    await expect(warning).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`compound-unlocked-${viewport.width}.png`) });
    await flow.add.click();
    await expect(page.getByRole("alert").filter({ hasText: "User rejected" })).toBeVisible();
    expect(flow.calls.filter((p) => p === "/api/selected-prepare")).toHaveLength(1);
    expect(wallet.ledger).toMatchObject([{ outcome: "rejected" }]);
    expect(flow.calls.some((p) => /broadcast$/.test(p))).toBe(false);
    expect(await page.evaluate((key) => localStorage.getItem(key), flow.attemptKey)).toBe(JSON.stringify(flow.attempt));
    expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), flow.receiptsKey))!)).toHaveLength(1);
    await page.reload(); await expect(warning).toBeVisible();
    await page.getByRole("textbox", { name: "Input limit" }).fill("1"); await expect(flow.add).toBeEnabled();
  });
}

test("unknown compound history stays a warning across 30 seconds and NFT changes without automatic submission", async ({ page, wallet }) => {
  await page.clock.install();
  const flow = await setup(page, wallet, { status: "pending", chainStatus: "pending" });
  await expect(flow.add).toBeEnabled();
  await page.clock.fastForward(31000);
  await expect(page.getByText(/previous compound transaction is unresolved/i)).toBeVisible();
  flow.setReply({ status: "manual-review", chainStatus: "unknown" });
  await page.getByRole("combobox", { name: "Select Raydium position" }).selectOption(flow.oldMint);
  // Selecting another NFT intentionally clears its amount and preview.
  await expect(page.getByRole("textbox", { name: "Input limit" })).toHaveValue("");
  await page.getByRole("textbox", { name: "Input limit" }).fill("1");
  await expect(flow.add).toBeEnabled();
  const checks = flow.calls.filter((p) => p === "/api/compound-confirm").length;
  await page.clock.runFor(4000);
  await expect.poll(() => flow.calls.filter((p) => p === "/api/compound-confirm").length).toBeGreaterThan(checks);
  await expect(flow.add).toBeEnabled();
  flow.setReply({ status: "manual-review", chainStatus: "success" });
  await page.clock.runFor(4000); await expect(flow.add).toBeEnabled();
  expect(wallet.ledger).toEqual([]); expect(flow.calls).not.toContain("/api/selected-prepare");
});

for (const status of ["failed", "expired"] as const) {
  test(`confirmed ${status} releases add and removes the unconfirmed receipt`, async ({ page, wallet }) => {
    const flow = await setup(page, wallet, { status, chainStatus: status });
    await expect(flow.add).toBeEnabled();
    expect(JSON.parse((await page.evaluate((key) => localStorage.getItem(key), flow.receiptsKey))!)).toEqual([]);
    expect(await page.evaluate((key) => localStorage.getItem(key), flow.attemptKey)).not.toBeNull();
    expect(wallet.ledger).toEqual([]);
  });
}

test("a different wallet's unresolved record cannot lock the connected wallet", async ({ page, wallet }) => {
  const flow = await setup(page, wallet, { status: "pending", chainStatus: "pending" }, true);
  await expect(flow.add).toBeEnabled(); expect(flow.calls).not.toContain("/api/compound-confirm");
  expect(await page.evaluate((key) => localStorage.getItem(key), flow.attemptKey)).not.toBeNull();
  expect(wallet.ledger).toEqual([]);
});
