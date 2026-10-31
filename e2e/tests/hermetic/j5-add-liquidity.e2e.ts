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

async function setup(page: Page, wallet: FakeWallet, options: { selectedStateGate?: () => Promise<void>; connectOnly?: boolean; prepareFails?: boolean; uncertainSend?: boolean; previewGate?: Promise<void>; previewFails?: boolean; skipPreviewWait?: boolean; historyStatus?: "pending" | "manual-review" | "invalid" | "legacy"; nativeSol?: boolean; finality?: () => string } = {}) {
  const positionMint = randomAddress(), mintA = randomAddress(), mintB = randomAddress();
  const inputMint = options.nativeSol ? "So11111111111111111111111111111111111111112" : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const poolId = randomAddress(), positionAccount = randomAddress();
  const selection = { positionMint, inputMint, inputKind: options.nativeSol ? "native" : "token" };
  const decimals = options.nativeSol ? 9 : 6;
  const requestedOf = (amount: string) => String(Math.round(Number(amount) * 10 ** decimals));
  const state = { wallet: wallet.address, ...selection, poolId, positionAccount,
    slot: 42, solLamports: 1_000_000_000, inputDecimals: decimals, inputBalance: options.nativeSol ? "200000311000" : "200000311", inputAccount: options.nativeSol ? null : randomAddress(), nftAta: randomAddress(),
    mintA, mintB, decimalsA: 6, decimalsB: 6, ownsNft: true, sufficientSol: true, unsupportedExtensions: [],
    paused: false, frozen: false, transferFee: false, rangeSide: "inside", inRange: true,
    price: "1", tickLower: -10, tickUpper: 10, liquidity: "100", currentAmounts: { a: "1000000", b: "1000000" },
    balances: { input: options.nativeSol ? "200000311000" : "200000311", a: "0", b: "0" }, fees: { a: "0", b: "0" }, rewards: [], eligible: true };
  const calls: string[] = [];
  const quoteRequests: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    calls.push(pathname);
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : {};
    const requested = requestedOf(String(body.amount ?? "1"));
    const preview = { wallet: wallet.address, ...selection, poolId, positionAccount, inputDecimals: decimals,
      requested, floorBps: body.floorBps ?? 9900,
      toleranceBps: body.toleranceBps ?? 100, expiresAt: Date.now() + 75000, passesFloor: false,
      spendA: "500000", spendB: "500000", minOutA: "495000", minOutB: "495000", decimalsA: 6, decimalsB: 6,
      mintA, mintB, liquidity: "100", roundtripCostInput: null,
      feeBps: 10, feeAmount: String(Math.floor(Number(requested) * 10 / 10_000)), feeWallet: randomAddress() };
    let value: unknown = {};
    if (pathname === "/api/wallet") value = { wallet: wallet.address, slot: 1, fetchedAt: Date.now(),
      positions: [{ ...state, symbolA: "AAA", symbolB: "BBB", feeTierBps: 1, tickCurrent: 0 }],
      assets: [{ kind: options.nativeSol ? "native" : "token", mint: inputMint, eligible: true, decimals, balance: state.inputBalance, totalBalance: state.inputBalance, reason: null }] };
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
    if (pathname === "/api/tx-send") {
      if (options.uncertainSend) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Uncertain send" }) });
      const tx = await import("@solana/web3.js").then(({ VersionedTransaction }) =>
        VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64")));
      const bs58 = (await import("bs58")).default;
      value = { signature: bs58.encode(tx.signatures[0]!) };
    }
    if (pathname === "/api/transaction-finality") value = { status: options.finality?.() ?? "pending" };
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
        expect(calls).not.toContain("/api/tx-send");
        expect(wallet.ledger).toEqual([]);
      } finally { release(); }
    });
  }
}

test("native SOL preview shows the 10 bps protocol fee in SOL", async ({ page, wallet }) => {
  await setup(page, wallet, { nativeSol: true });
  await expect(page.getByText("Preview ready. Final checks run when you add liquidity.")).toBeVisible();
  await expect(page.getByText("Protocol fee (0.10%)")).toBeVisible();
  await expect(page.getByText("0.001 SOL", { exact: true })).toBeVisible();
});

test("input enables Add after a lightweight preview; no automatic simulation or prepare", async ({ page, wallet }) => {
  const { calls, selection } = await setup(page, wallet);
  await expect(page.getByText("Preview ready. Final checks run when you add liquidity.")).toBeVisible();
  expect(calls.filter((p) => p === "/api/selected-quote")).toHaveLength(1);
  expect(calls).not.toContain("/api/selected-preflight"); expect(calls).not.toContain("/api/selected-prepare");
  expect(wallet.ledger).toEqual([]);
  await expect(page.getByText("Checked when you add liquidity", { exact: true })).toBeVisible();
  await expect(page.getByText("Protocol fee (0.10%)")).toBeVisible();
  const inputLabel = `${selection.inputMint.slice(0, 5)}…${selection.inputMint.slice(-5)}`;
  await expect(page.getByText(`0.001 ${inputLabel}`, { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("add-preview-desktop.png") });
});

test("one Add prepares once, signs the same message, broadcasts once and persists pending", async ({ page, wallet }) => {
  const { calls, add } = await setup(page, wallet);
  await add.click();
  await expect.poll(() => calls.filter((p) => p === "/api/tx-send").length).toBe(1);
  expect(calls.filter((p) => p === "/api/selected-prepare")).toHaveLength(1);
  expect(wallet.ledger).toHaveLength(1);
  await expect(page.getByText("Transaction status: pending", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("add-pending.png") });
});

for (const viewport of [{ name: "desktop", width: 1280, height: 900 }, { name: "375", width: 375, height: 812 }] as const) {
  test(`expired add: status dialog offers Try again, which re-prepares and signs a fresh transaction (${viewport.name})`, async ({ page, wallet }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    let finality = "expired";
    const { calls, add } = await setup(page, wallet, { finality: () => finality });
    await add.click();
    await expect.poll(() => calls.filter((p) => p === "/api/tx-send").length).toBe(1);
    await expect(page.getByText("Transaction status: expired", { exact: true })).toBeVisible();
    // On a phone the expiry toast overlaps the aside, so open the status dialog from the keyboard.
    const statusButton = page.getByRole("button", { name: "View transaction status and tx hash" });
    await statusButton.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Transaction expired" })).toBeVisible();
    const retry = dialog.getByRole("button", { name: "Try again", exact: true });
    await expect(retry).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`add-dialog-expired-try-again-${viewport.name}.png`), animations: "disabled" });
    finality = "pending";
    await retry.click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => calls.filter((p) => p === "/api/selected-prepare").length).toBe(2);
    await expect.poll(() => calls.filter((p) => p === "/api/tx-send").length).toBe(2);
    expect(wallet.ledger).toHaveLength(2);
  });

  test(`confirmed add: status dialog still shows success after the success toast auto-closes (${viewport.name})`, async ({ page, wallet }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { calls, add } = await setup(page, wallet, { finality: () => "confirmed" });
    await add.click();
    await expect.poll(() => calls.filter((p) => p === "/api/tx-send").length).toBe(1);
    await expect(page.getByText("Transaction status: success", { exact: true })).toBeVisible();
    // SUCCESS_NOTICE_MS is 8 s: wait past it so the success toast has closed on its own.
    await page.waitForTimeout(9_000);
    await expect(page.getByRole("button", { name: "Dismiss notice" })).toHaveCount(0);
    await expect(page.getByText("Transaction status: success", { exact: true })).toBeVisible();
    const statusButton = page.getByRole("button", { name: "View transaction status and tx hash" });
    await statusButton.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Liquidity added" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Confirming on Solana…" })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`add-dialog-success-after-toast-${viewport.name}.png`), animations: "disabled" });
  });

  test(`expired add: dismissing the expiry toast keeps the dialog on expired with Try again (${viewport.name})`, async ({ page, wallet }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { calls, add } = await setup(page, wallet, { finality: () => "expired" });
    await add.click();
    await expect.poll(() => calls.filter((p) => p === "/api/tx-send").length).toBe(1);
    await expect(page.getByText("Transaction status: expired", { exact: true })).toBeVisible();
    const dismiss = page.getByRole("button", { name: "Dismiss notice" });
    await dismiss.first().click();
    await expect(dismiss).toHaveCount(0);
    await expect(page.getByText("Transaction status: expired", { exact: true })).toBeVisible();
    const statusButton = page.getByRole("button", { name: "View transaction status and tx hash" });
    await statusButton.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Transaction expired" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`add-dialog-expired-toast-dismissed-${viewport.name}.png`), animations: "disabled" });
  });
}

test("failed prepare never calls the wallet or broadcast", async ({ page, wallet, guards }) => {
  guards.allowConsole(/^Failed to load resource: the server responded with a status of 400/);
  const { calls, add } = await setup(page, wallet, { prepareFails: true });
  await add.click(); await expect(page.getByRole("alert").filter({ hasText: "Simulation failed" }).first()).toBeVisible();
  expect(wallet.ledger).toEqual([]); expect(calls).not.toContain("/api/tx-send");
});

test("wallet instruction-data mutation blocks broadcast", async ({ page, wallet, guards }) => {
  guards.allowConsole(/Wallet removed or changed a required instruction/);
  wallet.mode = "tweak-bytes";
  const { calls, add } = await setup(page, wallet);
  await add.click(); await expect(page.getByRole("alert").filter({ hasText: "Wallet removed or changed a required instruction" }).first()).toBeVisible();
  expect(calls).not.toContain("/api/tx-send");
});

test("wallet Lighthouse extra instruction still broadcasts", async ({ page, wallet }) => {
  wallet.mode = "lighthouse";
  const { calls, add } = await setup(page, wallet);
  await add.click();
  await expect.poll(() => calls.filter((p) => p === "/api/tx-send").length).toBe(1);
  expect(wallet.ledger[0]).toMatchObject({ outcome: "signed", mode: "lighthouse" });
});

test("wallet raised ComputeBudget priority fee still broadcasts", async ({ page, wallet }) => {
  wallet.mode = "priority-fee";
  const { calls, add } = await setup(page, wallet);
  await add.click();
  await expect.poll(() => calls.filter((p) => p === "/api/tx-send").length).toBe(1);
  expect(wallet.ledger[0]).toMatchObject({ outcome: "signed", mode: "priority-fee" });
});

test("ambiguous send warns after reload without locking or automatically resending", async ({ page, wallet }) => {
  const { calls, add } = await setup(page, wallet, { uncertainSend: true });
  await add.click();
  await expect.poll(() => calls.filter((p) => p === "/api/tx-send").length).toBe(1);
  await expect(page.getByText("Transaction status: pending", { exact: true })).toBeVisible();
  await page.reload();
  // The shared notice host resumes the saved signature and only polls its status; it never resends.
  await expect(page.getByText("Checking a previous transaction…", { exact: true }).first()).toBeVisible();
  await fillReadyInput(page);
  await expect(add).toBeEnabled();
  expect(wallet.ledger).toHaveLength(1);
  expect(calls.filter((p) => p === "/api/tx-send")).toHaveLength(1);
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
    // Records from the removed per-flow attempt store are ignored: no blocking banner, no dialog.
    await expect(page.getByText(/Previous transaction is unconfirmed or needs verification/)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await fillReadyInput(page);
    await expect(add).toBeEnabled();
    expect(calls).not.toContain("/api/selected-prepare");
    expect(calls).not.toContain("/api/tx-send");
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
