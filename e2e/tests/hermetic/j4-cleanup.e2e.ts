import bs58 from "bs58";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";
import { FakeWallet } from "../../fake-wallet/node-signer";

test("discovers historical yield without a position and cleans both groups through pending finality", async ({ page, wallet }) => {
  const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const owner = new PublicKey(wallet.address);
  const receipts = await Promise.all([0, 1].map(async group => ({ wallet: wallet.address,
    positionMint: Keypair.generate().publicKey.toBase58(), sourceSignature: bs58.encode(new Uint8Array(64).fill(10 + group)),
    compoundAccounts: await Promise.all([0, 1].map(async leg => {
      const seed = `${group}${leg}`.repeat(11);
      return { seed, address: (await PublicKey.createWithSeed(owner, seed, tokenProgram)).toBase58(),
        mint: Keypair.generate().publicKey.toBase58(), program: tokenProgram.toBase58(), space: 165, rentLamports: 1_488_440 };
    })),
  })));
  await page.route("**/api/compound-recover-discover", route => route.fulfill({ json: {
    wallet: wallet.address, receipts, scanned: 4, totalCandidates: 4, incomplete: false, errors: 0, nextCursor: null,
  } }));
  await page.route("**/api/compound-recover-prepare", route => {
    const body = route.request().postDataJSON();
    const blockhash = Keypair.generate().publicKey.toBase58();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(body.compoundAccounts[0].address), lamports: 0 })],
    }).compileToV0Message());
    return route.fulfill({ json: { permit: "hermetic-cleanup-only", unsignedTransaction: Buffer.from(tx.serialize()).toString("base64"),
      summary: { operation: "recovery", simulated: true, wallet: wallet.address, blockhash, lastValidBlockHeight: 150,
        expiresAt: Date.now() + 60_000, feeLamports: 5000, sizeBytes: tx.serialize().length,
        compoundAccounts: body.compoundAccounts.map((account: Record<string, unknown>) => ({ ...account,
          amount: "1", decimals: 6, sourceLamports: account.rentLamports, destination: Keypair.generate().publicKey.toBase58() })) } } });
  });
  const broadcasts: string[] = [];
  await page.route("**/api/compound-recover-broadcast", route => {
    const body = route.request().postDataJSON();
    const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
    expect(FakeWallet.verify(wallet.address, tx.message.serialize(), tx.signatures[0]!)).toBe(true);
    const signature = bs58.encode(tx.signatures[0]!);
    broadcasts.push(signature);
    return route.fulfill({ json: { signature } });
  });
  const confirmations = new Map<string, number>();
  await page.route("**/api/compound-confirm", route => {
    const { attempt } = route.request().postDataJSON();
    const count = (confirmations.get(attempt.signature) ?? 0) + 1;
    confirmations.set(attempt.signature, count);
    return route.fulfill({ json: { signature: attempt.signature, state: null,
      status: count === 1 ? "pending" : "success", chainStatus: count === 1 ? "pending" : "success" } });
  });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await new ConnectModal(page, wallet).connect();
  await expect(page.getByRole("heading", { name: "Clean up leftover yield" })).toBeVisible();
  await page.getByRole("button", { name: "Find leftover yield" }).click();
  await expect(page.getByText(/Wallet scan complete/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Clean up all balances (2)", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Clean up all balances (2)", exact: true }).click();
  await expect(page.getByText(/All selected yield accounts cleaned up/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Clean up all balances (0)", exact: true })).toBeDisabled();
  expect(broadcasts).toHaveLength(2);
  expect(wallet.signedTransactions).toHaveLength(2);
  expect([...confirmations.values()].every(count => count >= 2)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("cleanup-complete.png"), fullPage: true });
});
