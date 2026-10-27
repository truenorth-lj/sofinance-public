import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";
import { buildOpenPositionTx, randomAddress } from "../../support/tx";
import type { Page } from "@playwright/test";
import { FakeWallet } from "../../fake-wallet/node-signer";

async function connectInModal(page: Page, wallet: FakeWallet) {
  const connect = page.getByRole("dialog", { name: "Create position" }).getByRole("button", { name: "Connect wallet", exact: true });
  if (await connect.count()) {
    await new ConnectModal(page, wallet).connect(connect);
  }
  await expect(new ConnectModal(page, wallet).navAddress).toBeVisible();
}

async function setup(page: Page, wallet: FakeWallet, mode: "ok" | "unknown" | "unsent" = "ok") {
  const poolId = randomAddress(), mintA = randomAddress(), mintB = randomAddress();
  const built = buildOpenPositionTx(wallet.address);
  const calls: string[] = [];
  let chainStatus = "pending";
  let sentSignature = "";
  await page.route("https://img-v1.raydium.io/**", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg"/>' }));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname; calls.push(path);
    const body = route.request().method() === "POST" ? route.request().postDataJSON() : {};
    const quote = { wallet: wallet.address, poolId, mintA, mintB, symbolA: "AAAx", symbolB: "AAA", inputMint: "So11111111111111111111111111111111111111112", inputKind: "native",
      inputDecimals: 9, decimalsA: 6, decimalsB: 6, requested: String(Math.round(Number(body.amount ?? "0.01") * 1e9)),
      liquidity: "100", tickLower: -60, tickUpper: 60, currentPrice: "1", tickCurrent: 0, tickSpacing: 1, rangePreset: "standard",
      rangeSide: "inside", warnings: [], minOutA: "500000", minOutB: "500000", amountMaxA: "500000", amountMaxB: "500000",
      roundtripCostInput: "1000", floorBps: 9900, passesFloor: true, expiresAt: Date.now() + 75000,
      solLamports: "1000000000", networkFeeLamportsEstimate: "5000", requiredSolLamports: "20000000",
      rent: { refundableLamports: "7000000", nonRefundableLamports: "1000000", walletTokenAccountLamports: "0" } };
    let value: unknown = {};
    if (path === "/api/rwa-pairs") value = { pairs: [{ poolAddress: poolId, mintA, mintB,
      symbolA: "AAAx", symbolB: "AAA", nameA: "AAA wrapped", nameB: "AAA", wrappedSymbol: "AAAx", plainSymbol: "AAA", baseSymbol: "AAA",
      feeTierBps: 1, tvlUsd: 100000, volume24hUsd: 10000, fees24hUsd: 10, estimatedFeeAprPct: 4, raydiumFeeApr24h: 4,
      token2022A: false, token2022B: false, freezeRisk: false, jupiterTagsA: [], jupiterTagsB: [] }],
      fetchedAt: new Date().toISOString(), scannedPools: 1, pagesFetched: 1, pairingRuleSummary: "Test pair", estimatedFeeAprLabel: "Estimated APR" };
    if (path === "/api/wallet") value = { assets: [{ kind: "native", mint: quote.inputMint, eligible: true, decimals: 9, balance: "1000000000" }] };
    if (path === "/api/token-metadata") value = {};
    if (path === "/api/sol-usdc-price") value = { rate: 150 };
    if (path === "/api/pool-range-apr") return route.fulfill({ status: 503, json: { error: "Estimate unavailable in this test" } });
    if (path === "/api/open-quote") value = quote;
    if (path === "/api/open-prepare") value = { permit: "e2e-permit", unsignedTransaction: built.b64,
      summary: { wallet: wallet.address, poolId, nftMint: built.nftMint, positionAccount: randomAddress(),
        blockhash: built.tx.message.recentBlockhash, lastValidBlockHeight: 1000, expiresAt: Date.now() + 75000,
        tickLower: -60, tickUpper: 60, quote } };
    if (path === "/api/open-broadcast") {
      const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
      sentSignature = bs58.encode(tx.signatures[0]!);
      expect(FakeWallet.verify(wallet.address, tx.message.serialize(), tx.signatures[0]!)).toBe(true);
      const saved = await page.evaluate(address => localStorage.getItem(`sofinance:open-position:v1:${address}`), wallet.address);
      expect(saved).toContain(sentSignature);
      if (mode !== "ok") return route.fulfill({ status: 503, json: { error: "E2E submission unavailable", ...(mode === "unsent" ? { sent: false } : {}) } });
      value = { signature: sentSignature, positionMint: built.nftMint };
    }
    if (path === "/api/open-status") value = { signature: body.attempt.signature, status: chainStatus };
    await route.fulfill({ json: value });
  });
  await page.goto(`/app/rwa-pairs?pool=${poolId}&open=1`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("dialog", { name: "Create position" })).toBeVisible();
  await connectInModal(page, wallet);
  await page.getByRole("textbox", { name: "Amount", exact: true }).fill("0.01");
  const create = page.getByRole("dialog").getByRole("button", { name: "Create position", exact: true });
  await expect(create).toBeEnabled();
  return { calls, create, setStatus: (status: string) => { chainStatus = status; }, signature: () => sentSignature };
}

test("RPC acceptance remains pending; reload tracks the same signature before showing Position opened", async ({ page, wallet, guards }) => {
  guards.allowConsole(/^Failed to load resource: the server responded with a status of 503/);
  const flow = await setup(page, wallet);
  await flow.create.click();
  await expect(page.getByText("Waiting for on-chain confirmation…", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Position opened", { exact: true })).toHaveCount(0);
  const signature = flow.signature();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Create position" })).toBeVisible();
  await connectInModal(page, wallet);
  await expect(page.getByRole("link", { name: "View original transaction on Solscan" })).toHaveAttribute("href", `https://solscan.io/tx/${signature}`);
  expect(wallet.ledger).toHaveLength(1); expect(flow.calls.filter(path => path === "/api/open-prepare")).toHaveLength(1);
  flow.setStatus("confirmed");
  await page.getByRole("button", { name: "Check transaction status" }).click();
  await expect(page.getByRole("button", { name: "Create another position" })).toBeVisible();
  await expect(page.getByText("Position opened", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("open-confirmed.png") });
});

test("unknown send retains the original signature, blocks another open and can report finalized failure", async ({ page, wallet, guards }) => {
  guards.allowConsole(/^Failed to load resource: the server responded with a status of 503/);
  const flow = await setup(page, wallet, "unknown");
  await flow.create.click();
  await expect(page.getByRole("link", { name: "View original transaction on Solscan" })).toBeVisible();
  await expect(page.getByText("Position opened", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("button", { name: "Create position", exact: true })).toHaveCount(0);
  flow.setStatus("failed"); await page.getByRole("button", { name: "Check transaction status" }).click();
  await expect(page.getByText("Open-position transaction failed on-chain. You can prepare a new transaction.")).toBeVisible();
  await expect(flow.create).toBeEnabled(); expect(wallet.ledger).toHaveLength(1);
});
