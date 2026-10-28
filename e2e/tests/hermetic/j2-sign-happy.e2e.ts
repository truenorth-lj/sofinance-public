// J2: the sign-link happy path for all three transaction kinds. The wallet signs locally (key stays in Node);
// the broadcast route is mocked, so nothing reaches any network. Everything between the click and the POST is real.
import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";
import { SignPage, BROADCAST_PATH } from "../../pages/sign-page";
import { makeScenario } from "../../support/scenario";
import type { SignKind } from "../../support/sign-token";

// AppKit passes chain "solana:mainnet" to signTransaction; the wallet-adapter wrapper passes none (observed, pinned).
const EXPECTED_CHAIN = process.env.E2E_PROVIDER === "adapter" ? null : "solana:mainnet";
const LABEL: Record<SignKind, string> = { "add-liquidity": "Add Liquidity", "open-position": "Open position", compound: "Compound" };

test.describe("J2 sign link, happy path", () => {
  for (const kind of ["compound", "add-liquidity", "open-position"] as const) {
    test(`${kind}: connect, sign locally, POST the signed transaction, success`, async ({ page, wallet }) => {
      const scenario = makeScenario(kind, wallet.address);
      const sign = new SignPage(page);
      await sign.mockBroadcast(kind);
      await sign.goto(scenario.token);

      // Before connecting: details are shown, no sign button.
      await sign.expectStatus("Connect your wallet to continue.");
      await expect(page.getByText(LABEL[kind], { exact: true })).toBeVisible();
      await expect(sign.signButton).toHaveCount(0);

      await new ConnectModal(page, wallet).connect();
      await sign.expectStatus("Review the transaction details below and sign to submit.");
      await page.screenshot({ path: test.info().outputPath(`j2-${kind}-ready.png`) });
      expect(wallet.ledger, "connecting must not sign").toEqual([]);

      await sign.signButton.click();
      await sign.expectStatus("Transaction submitted successfully! Redirecting to the app...");
      await page.screenshot({ path: test.info().outputPath(`j2-${kind}-success.png`) });

      // Exactly one wallet signature request, in the payer slot (chain id depends on the provider, see above).
      expect(wallet.ledger).toHaveLength(1);
      expect(wallet.ledger[0]).toMatchObject({ kind: "signTransaction", outcome: "signed", chain: EXPECTED_CHAIN, signerIndex: 0 });

      // Exactly one broadcast, to the route of this kind, with the documented body.
      expect(sign.broadcasts).toHaveLength(1);
      const call = sign.broadcasts[0]!;
      expect(call.kind).toBe(kind);
      expect(call.body.unsignedTransaction).toBe(scenario.payload.unsignedTransaction);
      if (kind === "add-liquidity") {
        expect(Object.keys(call.body).sort()).toEqual(["signedTransaction", "unsignedTransaction", ...Object.keys(scenario.submitArgs)].sort());
        expect(call.body.selection).toEqual(scenario.submitArgs.selection);
      } else {
        expect(Object.keys(call.body).sort()).toEqual(["permit", "signedTransaction", "summary", "unsignedTransaction", "wallet"]);
        expect(call.body.summary).toEqual(scenario.submitArgs.summary);
      }
      expect(call.body.permit).toBe(scenario.submitArgs.permit);
      expect(call.body.wallet).toBe(wallet.address);

      // The posted transaction carries a valid wallet signature over the UNMODIFIED message.
      const posted = VersionedTransaction.deserialize(Buffer.from(String(call.body.signedTransaction), "base64"));
      expect(Buffer.from(posted.message.serialize()).equals(Buffer.from(scenario.built.tx.message.serialize()))).toBe(true);
      expect(sign.signatureVerifies(call, wallet.address, 0)).toBe(true);

      // The success link shows the same signature the wallet produced.
      const signature = bs58.encode(posted.signatures[0]!);
      await expect(page.getByRole("link", { name: /View on Solscan/ })).toHaveAttribute("href", `https://solscan.io/tx/${signature}`);
    });
  }

  test("open-position MCP signUrl keeps the fallback NFT-mint partial signature and fills only the wallet slot", async ({ page, wallet }) => {
    const scenario = makeScenario("open-position", wallet.address);
    const sign = new SignPage(page);
    await sign.mockBroadcast("open-position");
    await sign.goto(scenario.token);
    await new ConnectModal(page, wallet).connect();
    await sign.signButton.click();
    await sign.expectStatus("Transaction submitted successfully! Redirecting to the app...");

    const call = sign.broadcasts[0]!;
    expect(sign.signatureVerifies(call, wallet.address, 0)).toBe(true);
    expect(sign.signatureVerifies(call, scenario.built.nftMint!, 1)).toBe(true);   // MCP-ONLY server partial-sign fallback survived
    expect(wallet.ledger[0]!.programIds).toEqual(["11111111111111111111111111111111"]);
  });

  test("the 'Waiting for wallet signature' state is shown while a slow wallet is thinking", async ({ page, wallet }) => {
    wallet.mode = "slow";
    const scenario = makeScenario("compound", wallet.address);
    const sign = new SignPage(page);
    await sign.mockBroadcast("compound");
    await sign.goto(scenario.token);
    await new ConnectModal(page, wallet).connect();
    await sign.signButton.click();
    await sign.expectStatus("Waiting for wallet signature...");
    // QUIRK (pinned): `showSign` requires status === "ready", so the sign button is REMOVED while signing; the
    // "Signing..." / "Submitting..." disabled-button branch in page.tsx can never render. A second click is impossible.
    await expect(sign.signButton).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Signing\.\.\./ })).toHaveCount(0);
    await sign.expectStatus("Transaction submitted successfully! Redirecting to the app...");
    expect(wallet.signedTransactions).toHaveLength(1);
  });

  test("each kind posts to its own broadcast route only", async ({ page, wallet }) => {
    const scenario = makeScenario("add-liquidity", wallet.address);
    const hits: string[] = [];
    for (const [kind, pattern] of Object.entries(BROADCAST_PATH)) {
      await page.route(pattern, (route) => { hits.push(kind); return route.fulfill({ status: 500, body: JSON.stringify({ error: "x" }), contentType: "application/json" }); });
    }
    await page.goto(`/app/sign/${scenario.token}`, { waitUntil: "domcontentloaded" });
    await new ConnectModal(page, wallet).connect();
    await page.getByRole("button", { name: "Sign and submit" }).click();
    await expect(page.getByText("x", { exact: true })).toBeVisible();
    expect(hits).toEqual(["add-liquidity"]);
  });
});
