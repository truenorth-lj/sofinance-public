// J3: sign-link negatives. Every test asserts the specific UI state/message AND that nothing was broadcast
// unless the page legitimately got past all of its guards.
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";
import { SignPage } from "../../pages/sign-page";
import { makeScenario } from "../../support/scenario";
import { randomAddress } from "../../support/tx";
import { mintSignToken, tamperToken } from "../../support/sign-token";

const EXPIRED = "This sign token has expired or is invalid. Sign tokens expire after 60-120 seconds.";
const SUCCESS = "Transaction submitted successfully! Redirecting to the app...";

async function openAndConnect(page: import("@playwright/test").Page, wallet: import("../../fake-wallet/node-signer").FakeWallet, token: string) {
  const sign = new SignPage(page);
  await sign.goto(token);
  await new ConnectModal(page, wallet).connect();
  return sign;
}

test.describe("J3 sign link, bad tokens", () => {
  test("expired token: 'expired' state, no details, no connect/sign buttons, nothing signed or broadcast", async ({ page, wallet }) => {
    const sign = new SignPage(page);
    await sign.mockBroadcast("compound");
    await sign.goto(makeScenario("compound", wallet.address, { expiresInMs: -1_000 }).token);
    await sign.expectStatus(EXPIRED);
    await expect(sign.signButton).toHaveCount(0);
    await expect(page.getByText("Transaction type")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("j3-expired.png") });
    expect(wallet.ledger).toEqual([]);
    expect(sign.broadcasts).toEqual([]);
  });

  const bad: [string, (wallet: string) => string][] = [
    ["tampered payload (one character flipped)", (w) => tamperToken(makeScenario("compound", w).token)],
    ["signed with another secret", (w) => makeScenario("compound", w, { secret: "some-other-secret" }).token],
    ["no signature part", () => "justonepart"],
    ["two parts, not a signature or data", () => "x.y"],
    ["valid format, garbage data", () => "AAAA.BBBB"],
  ];
  for (const [name, make] of bad) {
    test(`${name}: rejected as invalid, nothing signed or broadcast`, async ({ page, wallet }) => {
      const sign = new SignPage(page);
      await sign.mockBroadcast("compound");
      await sign.goto(make(wallet.address));
      await sign.expectStatus(EXPIRED);
      await expect(sign.signButton).toHaveCount(0);
      expect(wallet.ledger).toEqual([]);
      expect(sign.broadcasts).toEqual([]);
    });
  }

  test("a token for a payload missing required fields is rejected", async ({ page, wallet }) => {
    const scenario = makeScenario("compound", wallet.address);
    const broken = { ...scenario.payload, permit: "" };      // verifySignToken requires a non-empty permit
    const sign = new SignPage(page);
    await sign.goto(mintSignToken(broken));
    await sign.expectStatus(EXPIRED);
    expect(wallet.ledger).toEqual([]);
  });
});

test.describe("J3 sign link, wrong wallet", () => {
  test("a different wallet connects: 'Wrong wallet connected', no sign button, disconnect works", async ({ page, wallet }) => {
    const expected = randomAddress();
    const scenario = makeScenario("compound", expected, { payer: expected });
    const sign = await openAndConnect(page, wallet, scenario.token);
    await sign.expectStatus(`Wrong wallet connected. Please connect wallet ${expected.slice(0, 5)}…${expected.slice(-5)}.`);
    await expect(sign.signButton).toHaveCount(0);
    await expect(sign.disconnectButton).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("j3-wrong-wallet.png") });
    expect(wallet.ledger).toEqual([]);

    await sign.disconnectButton.click();
    await sign.expectStatus("Connect your wallet to continue.");
    expect(wallet.ledger).toEqual([]);
  });
});

test.describe("J3 sign link, wallet / transaction guards", () => {
  test("payer mismatch: a token whose transaction is paid by another account is refused before the wallet is asked", async ({ page, wallet }) => {
    const scenario = makeScenario("compound", wallet.address, { payer: randomAddress() });
    const sign = new SignPage(page);
    await sign.mockBroadcast("compound");
    await sign.goto(scenario.token);
    await new ConnectModal(page, wallet).connect();
    await sign.signButton.click();
    await sign.expectStatus("Transaction payer mismatch");
    expect(wallet.ledger, "the wallet must not even be asked").toEqual([]);
    expect(sign.broadcasts).toEqual([]);
  });

  test("user rejects in the wallet: message shown, nothing broadcast, page is a dead end until reload (pinned)", async ({ page, wallet }) => {
    wallet.mode = "reject";
    const scenario = makeScenario("compound", wallet.address);
    const sign = await openAndConnect(page, wallet, scenario.token);
    await sign.signButton.click();
    await sign.expectStatus("You cancelled in your wallet. Nothing was sent.");
    await page.screenshot({ path: test.info().outputPath("j3-rejected.png") });
    expect(wallet.ledger).toHaveLength(1);
    expect(wallet.ledger[0]).toMatchObject({ outcome: "rejected" });
    expect(sign.broadcasts).toEqual([]);
    // QUIRK (pinned): after ANY failure the page switches to its error state, which has no sign button, so the user
    // can not retry without reloading the link.
    await expect(sign.signButton).toHaveCount(0);
    expect(wallet.ledger).toHaveLength(1);
  });

  test("wallet appends a Memo instruction: core ixs still match, so the signed tx is posted", async ({ page, wallet }) => {
    wallet.mode = "mutate-message";
    const scenario = makeScenario("compound", wallet.address);
    const sign = new SignPage(page);
    await sign.mockBroadcast("compound");
    await sign.goto(scenario.token);
    await new ConnectModal(page, wallet).connect();
    await sign.signButton.click();
    await sign.expectStatus(SUCCESS);
    await page.screenshot({ path: test.info().outputPath("j3-wallet-modified.png") });
    expect(wallet.ledger).toHaveLength(1);
    expect(wallet.ledger[0]).toMatchObject({ outcome: "signed", mode: "mutate-message" });
    expect(sign.broadcasts).toHaveLength(1);
    // The shared send route carries only the signed bytes (the wallet's added Memo included).
    expect(Object.keys(sign.broadcasts[0]!.body)).toEqual(["signedTransaction"]);
  });

  test("wallet changes instruction data: required-instruction guard, nothing broadcast", async ({ page, wallet, guards }) => {
    guards.allowConsole(/Wallet removed or changed a required instruction/);
    wallet.mode = "tweak-bytes";
    const scenario = makeScenario("compound", wallet.address);
    const sign = new SignPage(page);
    await sign.mockBroadcast("compound");
    await sign.goto(scenario.token);
    await new ConnectModal(page, wallet).connect();
    await sign.signButton.click();
    await sign.expectStatus(/required instruction/);
    expect(wallet.ledger[0]).toMatchObject({ outcome: "signed", mode: "tweak-bytes" });
    expect(sign.broadcasts).toEqual([]);
  });

  test("wallet returns an unsigned transaction (all-zero signature): 'required signature is missing', nothing broadcast", async ({ page, wallet }) => {
    wallet.mode = "no-signature";
    const scenario = makeScenario("compound", wallet.address);
    const sign = new SignPage(page);
    await sign.mockBroadcast("compound");
    await sign.goto(scenario.token);
    await new ConnectModal(page, wallet).connect();
    await sign.signButton.click();
    await sign.expectStatus("A required signature is missing, so nothing was sent.");
    expect(sign.broadcasts).toEqual([]);
  });

  for (const kind of ["compound", "add-liquidity", "open-position"] as const) {
    test(`${kind}: a Lighthouse-style guard instruction added by the wallet is relayed as signed bytes`, async ({ page, wallet }) => {
      wallet.mode = "lighthouse";
      const scenario = makeScenario(kind, wallet.address);
      const sign = new SignPage(page);
      await sign.mockBroadcast(kind);
      await sign.goto(scenario.token);
      await new ConnectModal(page, wallet).connect();
      await sign.signButton.click();
      await sign.expectStatus(SUCCESS);
      expect(wallet.ledger[0]!.programIds).toContain("L2TExMFKdjpN9kozasaurPPf4nCVfRTb7cTZo5GsqqY");
      expect(sign.broadcasts).toHaveLength(1);
      expect(Object.keys(sign.broadcasts[0]!.body)).toEqual(["signedTransaction"]);
    });
  }

  test("open-position without an NFT-mint signature is refused after the wallet signs (MCP signUrl)", async ({ page, wallet }) => {
    const scenario = makeScenario("open-position", wallet.address, { serverSigns: false });
    const sign = new SignPage(page);
    await sign.mockBroadcast("open-position");
    await sign.goto(scenario.token);
    await new ConnectModal(page, wallet).connect();
    await sign.signButton.click();
    await sign.expectStatus("A required signature is missing, so nothing was sent.");
    expect(wallet.ledger).toHaveLength(1);
    expect(sign.broadcasts).toEqual([]);
  });
});

test.describe("J3 sign link, broadcast failures", () => {
  test("sent:false from the server: the error says nothing was sent", async ({ page, wallet }) => {
    const scenario = makeScenario("compound", wallet.address);
    const sign = new SignPage(page);
    await sign.mockBroadcast("compound", "sent-false");
    await sign.goto(scenario.token);
    await new ConnectModal(page, wallet).connect();
    await sign.signButton.click();
    await sign.expectStatus("E2E mock: blocked. Nothing was sent.");
    expect(sign.broadcasts).toHaveLength(1);
    expect(wallet.ledger).toHaveLength(1);
  });

  test("a server error without sent:false may have reached the network: tracked as uncertain with a Solscan link, never retried", async ({ page, wallet }) => {
    const scenario = makeScenario("compound", wallet.address);
    const sign = new SignPage(page);
    await sign.mockBroadcast("compound", "server-error");
    await sign.goto(scenario.token);
    await new ConnectModal(page, wallet).connect();
    await sign.signButton.click();
    await sign.expectStatus(/We could not confirm the send/);
    await expect(page.getByRole("link", { name: /View on Solscan/ }).first()).toBeVisible();
    await expect(page.getByText(SUCCESS)).toHaveCount(0);
    await page.waitForTimeout(1500);                       // a (forbidden) retry loop would show up as a 2nd POST
    expect(sign.broadcasts).toHaveLength(1);
  });

  test("the server answers with a different signature: tracked by our own signature as uncertain, no success state", async ({ page, wallet }) => {
    const scenario = makeScenario("compound", wallet.address);
    const sign = new SignPage(page);
    await sign.mockBroadcast("compound", "wrong-signature");
    await sign.goto(scenario.token);
    await new ConnectModal(page, wallet).connect();
    await sign.signButton.click();
    await sign.expectStatus(/We could not confirm the send/);
    await expect(page.getByRole("link", { name: /View on Solscan/ }).first()).toBeVisible();
    await expect(page.getByText(SUCCESS)).toHaveCount(0);
  });
});
