// The wallet signs and sends, then throws (seen on mainnet: Phantom `{"code":400,"message":"Request … rejected by user"}`
// after the INTC add had landed). The app must check Solana before saying anything, lock Add and Recalculate while it
// checks, then show success with a Solscan link, or "Nothing was sent, safe to retry" only once the lookup says the
// blockhash expired and nothing landed. Nothing is broadcast: /api/tx-landed and finality are mocked.
import bs58 from "bs58";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";
import { randomAddress, buildSingleSignerTx } from "../../support/tx";
import type { Page } from "@playwright/test";
import type { FakeWallet } from "../../fake-wallet/node-signer";

const LANDED_SIG = bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256));
/** Local review screenshots (E2E_SCREENSHOT_DIR) or the test's own output folder. */
function shot(name: string) {
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (!dir) return test.info().outputPath(`${name}.png`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

async function setup(page: Page, wallet: FakeWallet, lookup: { outcome: "landed" | "not-landed"; gate: Promise<void> }) {
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
  let landedChecks = 0;
  let finality = "pending";
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    calls.push(pathname);
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : {};
    const requested = String(Math.round(Number(body.amount ?? "1") * 1e6));
    const preview = { wallet: wallet.address, ...selection, poolId, positionAccount, inputDecimals: 6, requested, floorBps: body.floorBps ?? 9900,
      toleranceBps: body.toleranceBps ?? 100, expiresAt: Date.now() + 75000, passesFloor: false,
      spendA: "500000", spendB: "500000", minOutA: "495000", minOutB: "495000", decimalsA: 6, decimalsB: 6,
      mintA, mintB, liquidity: "100", roundtripCostInput: null, feeBps: 10, feeAmount: "1000", feeWallet: randomAddress() };
    let value: unknown = {};
    if (pathname === "/api/wallet") value = { wallet: wallet.address, slot: 1, fetchedAt: Date.now(),
      positions: [{ ...state, symbolA: "AAA", symbolB: "BBB", feeTierBps: 1, tickCurrent: 0 }],
      assets: [{ kind: "token", mint: inputMint, eligible: true, decimals: 6, balance: state.inputBalance, totalBalance: state.inputBalance, reason: null }] };
    if (pathname === "/api/selected-state" || pathname === "/api/compound-state") value = state;
    if (pathname === "/api/selected-quote") value = preview;
    if (pathname === "/api/selected-prepare") {
      const built = buildSingleSignerTx(wallet.address);
      value = { quote: preview, simulated: true, expiresAt: preview.expiresAt, permit: "test-permit", sendPermit: "test-send-permit",
        unsignedTransaction: built.b64, blockhash: built.tx.message.recentBlockhash, lastValidBlockHeight: 1000,
        startingLiquidity: state.liquidity, startingBalances: state.balances, simulatedSolDebitLamports: "5000" };
    }
    if (pathname === "/api/tx-send") throw new Error("The wallet sends; the app must never relay or resend here");
    if (pathname === "/api/tx-landed") {
      landedChecks++;
      expect(body).toMatchObject({ sendPermit: "test-send-permit", lastValidBlockHeight: 1000 });
      await lookup.gate;
      value = lookup.outcome === "landed" ? { status: "landed", signature: LANDED_SIG } : { status: "not-landed" };
    }
    if (pathname === "/api/transaction-finality") value = { status: finality };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
  await page.goto("/app?view=deposit");
  await new ConnectModal(page, wallet).connect();
  await expect(page.getByRole("button", { name: "MAX", exact: true })).toBeEnabled();
  await page.getByRole("textbox", { name: "Input limit" }).fill("1");
  const add = page.getByRole("button", { name: "Add liquidity", exact: true });
  await expect(add).toBeEnabled();
  return { calls, add, landedChecks: () => landedChecks, confirm: () => { finality = "confirmed"; } };
}

async function expectCheckingLocked(page: Page, name: string) {
  const checking = page.getByRole("button", { name: "Checking Solana…", exact: true });
  await expect(checking).toBeVisible(); await expect(checking).toBeDisabled();
  await expect(page.getByRole("button", { name: "Recalculate" })).toHaveCount(0);
  await expect(page.getByText(/Your wallet returned an error, but the transaction may still have gone through/).first()).toBeVisible();
  await expect(page.getByText(/Request [0-9a-f]{8}|"code"|\{"/)).toHaveCount(0);
  await page.screenshot({ path: shot(name) });
}

for (const [width, label] of [[1280, "desktop"], [375, "375"]] as const) {
  test.describe(`wallet error after send at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test.describe("Phantom 400 'rejected by user', transaction landed", () => {
      test.use({ signAndSendError: { message: '{"code":400,"message":"Request ce8e2677ab12cd34 rejected by user"}' } });
      test("checks Solana, locks Add and Recalculate, then shows success with a Solscan link", async ({ page, wallet, guards }) => {
        guards.allowConsole(/rejected by user|WalletSendTransactionError/i);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const { calls, add, landedChecks, confirm } = await setup(page, wallet, { outcome: "landed", gate });
        await add.click();
        await expect.poll(landedChecks).toBeGreaterThan(0);
        await expectCheckingLocked(page, `checking-${label}`);
        expect(wallet.signedTransactions).toHaveLength(1);
        confirm(); release();
        await expect(page.getByRole("link", { name: /on Solscan/ }).first()).toHaveAttribute("href", `https://solscan.io/tx/${LANDED_SIG}`);
        await expect(page.getByText("Liquidity added", { exact: true }).filter({ visible: true }).first()).toBeVisible();
        await expect(page.getByText("Transaction status: success", { exact: true })).toBeVisible();
        await page.screenshot({ path: shot(`landed-success-${label}`) });
        expect(calls).not.toContain("/api/tx-send");
        expect(calls.filter((p) => p === "/api/selected-prepare")).toHaveLength(1);
        expect(wallet.signedTransactions).toHaveLength(1);
      });
    });

    test.describe("4001 user rejection, nothing landed before expiry", () => {
      test.use({ signAndSendError: { message: "User rejected the request.", code: 4001 } });
      test("checks Solana, then says cancelled, nothing was sent, safe to retry", async ({ page, wallet, guards }) => {
        guards.allowConsole(/rejected the request|WalletSendTransactionError/i);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const { calls, landedChecks, add } = await setup(page, wallet, { outcome: "not-landed", gate });
        await add.click();
        await expect.poll(landedChecks).toBeGreaterThan(0);
        await expect(page.getByRole("button", { name: "Checking Solana…", exact: true })).toBeDisabled();
        release();
        const message = "You cancelled in your wallet. We checked Solana and it did not go through. Nothing was sent, safe to retry.";
        await expect(page.getByText(message).first()).toBeVisible();
        await page.screenshot({ path: shot(`not-landed-safe-to-retry-${label}`) });
        expect(calls).not.toContain("/api/tx-send");
        expect(wallet.signedTransactions).toHaveLength(1);
      });
    });
  });
}
