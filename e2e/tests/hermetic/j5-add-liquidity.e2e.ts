import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";
import { randomAddress, buildSingleSignerTx } from "../../support/tx";
import type { Page } from "@playwright/test";
import type { FakeWallet } from "../../fake-wallet/node-signer";

async function fillReadyInput(page: Page) {
  await expect(page.getByRole("button", { name: "MAX", exact: true })).toBeEnabled();
  const input = page.getByRole("textbox", { name: "Input limit" });
  await input.fill("1");
  await expect(input).toHaveValue("1");
}

async function setup(page: Page, wallet: FakeWallet, options: { selectedStateGate?: () => Promise<void>; connectOnly?: boolean; prepareFails?: boolean; uncertainSend?: boolean; previewGate?: Promise<void>; previewFails?: boolean; skipPreviewWait?: boolean; historyStatus?: "pending" | "manual-review" | "invalid" | "legacy" } = {}) {
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
  const quoteRequests: Record<string, unknown>[] = [];
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
    if (pathname === "/api/selected-state") await options.selectedStateGate?.();
    if (pathname === "/api/selected-state" || pathname === "/api/compound-state") value = state;
    if (pathname === "/api/selected-quote") {
      quoteRequests.push(body);
      await options.previewGate;
      if (options.previewFails) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Quote unavailable" }) });
      value = preview;
    }
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
    if (pathname === "/api/selected-status") value = { status: options.historyStatus === "manual-review" ? "manual-review" : "pending", state: null, signature: body.signature };
    if (pathname === "/api/transaction-finality") value = { status: "pending" };
    if (pathname === "/api/beam-status") value = { beam: null };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
  if (options.historyStatus) {
    const prior = { version: 2, wallet: wallet.address, selection: { ...selection, positionMint: randomAddress() },
      poolId, positionAccount, signature: "1".repeat(64), createdAt: Date.now(), requested: "1000000", floorBps: 9900,
      startingBalances: state.balances, startingLiquidity: "1", expectedLiquidity: "2", blockhash: randomAddress(), lastValidBlockHeight: 100 };
    await page.addInitScript(({ prior, kind }) => {
      const key = kind === "legacy" ? `sofinance:atomic:${prior.wallet}` : `sofinance:selected-atomic:v2:${prior.wallet}`;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, kind === "invalid" ? "invalid old record" : JSON.stringify(prior));
    }, { prior, kind: options.historyStatus });
  }
  await page.goto("/app?view=deposit");
  await new ConnectModal(page, wallet).connect();
  if (!options.connectOnly) await fillReadyInput(page);
  const add = page.getByRole("button", { name: "Add liquidity", exact: true });
  if (!options.connectOnly && !options.skipPreviewWait) await expect(add).toBeEnabled();
  return { calls, add, quoteRequests, selection };
}

// Hold the actual selected-state response, without changing product timers. The
// disabled assertion must run BEFORE the readiness wait used by ordinary setup.
for (const historyStatus of [undefined, "legacy"] as const) {
  for (const entry of ["connect", "reload"] as const) {
    test(`input readiness waits for matching state on ${entry} with ${historyStatus ?? "no"} history`, async ({ page, wallet }) => {
      let holdState = entry === "connect";
      let heldRequests = 0;
      let release!: () => void;
      const stateGate = new Promise<void>(resolve => { release = resolve; });
      const selectedStateGate = async () => {
        if (holdState) { heldRequests++; await stateGate; }
      };
      try {
        const { calls, add, quoteRequests, selection } = await setup(page, wallet, {
          historyStatus, selectedStateGate, connectOnly: entry === "connect",
        });
        const previousQuotes = quoteRequests.length;
        if (entry === "reload") { holdState = true; await page.reload(); }
        await expect.poll(() => heldRequests).toBe(1);
        const input = page.getByRole("textbox", { name: "Input limit" });
        await expect(page.getByText("Verifying selected position", { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "MAX", exact: true })).toBeDisabled();
        await expect(input).toBeDisabled();
        await expect(input).toHaveValue("");
        await expect(add).toBeDisabled();
        expect(quoteRequests).toHaveLength(previousQuotes);
        release();
        await fillReadyInput(page);
        await expect(page.getByText("Preview ready. Final checks run when you add liquidity.")).toBeVisible();
        await expect(add).toBeEnabled();
        // Check again after the quote round-trip: an accepted keystroke alone
        // would miss the delayed reset that originally erased this amount.
        await expect(input).toHaveValue("1");
        expect(quoteRequests.slice(previousQuotes)).toEqual([
          expect.objectContaining({ wallet: wallet.address, ...selection, amount: "1" }),
        ]);
        expect(calls).not.toContain("/api/selected-preflight");
        expect(calls).not.toContain("/api/selected-prepare");
        expect(calls).not.toContain("/api/selected-broadcast");
        expect(wallet.ledger).toEqual([]);
      } finally { release(); }
    });
  }
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
  await expect(page.getByText("Transaction status: pending", { exact: true })).toBeVisible();
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

test("ambiguous send warns after reload without locking or automatically resending", async ({ page, wallet }) => {
  const { calls, add } = await setup(page, wallet, { uncertainSend: true });
  await add.click();
  await expect.poll(() => calls.filter((p) => p === "/api/selected-broadcast").length).toBe(1);
  await expect(page.getByText("Transaction status: pending", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(/Previous transaction is unconfirmed or needs verification/).first()).toBeVisible();
  await fillReadyInput(page);
  await expect(add).toBeEnabled();
  expect(wallet.ledger).toHaveLength(1);
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

for (const historyStatus of ["pending", "manual-review", "invalid", "legacy"] as const) {
  test(`old ${historyStatus} history allows Add and survives reload without signing`, async ({ page, wallet }) => {
    const { calls, add } = await setup(page, wallet, { historyStatus });
    if (historyStatus !== "legacy") await expect(page.getByText(/Previous transaction is unconfirmed or needs verification/).first()).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await fillReadyInput(page);
    await expect(add).toBeEnabled();
    expect(calls).not.toContain("/api/selected-prepare");
    expect(calls).not.toContain("/api/selected-broadcast");
    expect(wallet.ledger).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`history-${historyStatus}.png`) });
  });
}

for (const width of [1280, 390]) {
  test(`loading preview has a bright spinner button, then enables Add at ${width}px`, async ({ page, wallet }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    let release!: () => void;
    const previewGate = new Promise<void>(resolve => { release = resolve; });
    const { calls, add } = await setup(page, wallet, { previewGate, skipPreviewWait: true });
    const loading = page.getByRole("button", { name: "Estimating liquidity…", exact: true });
    await expect(loading).toBeVisible(); await expect(loading).toBeDisabled();
    await expect(loading).toHaveAttribute("aria-busy", "true");
    await expect(loading.locator("svg")).toHaveClass(/animate-spin/);
    expect(await loading.evaluate(button => getComputedStyle(button).opacity)).toBe("1");
    await expect(loading.locator("svg")).toHaveCSS("animation-name", "spin");
    await loading.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath(`preview-loading-${width}.png`) });
    expect(wallet.ledger).toEqual([]); expect(calls).not.toContain("/api/selected-prepare");
    release(); await expect(add).toBeEnabled();
    await expect(add).toHaveAttribute("aria-busy", "false");
    await expect(add.locator("svg")).not.toHaveClass(/animate-spin/);
    expect(wallet.ledger).toEqual([]);
  });
}

test("failed preview stops the spinner and offers explicit recalculation", async ({ page, wallet, guards }) => {
  guards.allowConsole(/^Failed to load resource: the server responded with a status of 503/);
  let release!: () => void;
  const previewGate = new Promise<void>(resolve => { release = resolve; });
  const { add } = await setup(page, wallet, { previewGate, previewFails: true, skipPreviewWait: true });
  await expect(page.getByRole("button", { name: "Estimating liquidity…", exact: true })).toBeVisible();
  release();
  await expect(page.getByRole("alert").filter({ hasText: "Quote unavailable" })).toBeVisible();
  await expect(add).toBeDisabled(); await expect(add).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "Recalculate" })).toBeVisible();
  expect(wallet.ledger).toEqual([]);
});
