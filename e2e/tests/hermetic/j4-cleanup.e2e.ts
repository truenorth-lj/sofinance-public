import bs58 from "bs58";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect, test } from "../fixtures";
import { ConnectModal } from "../../pages/connect-modal";
import { FakeWallet } from "../../fake-wallet/node-signer";

for (const scenario of ["packed", "chunked", "interrupted-confirmation"] as const) {
  test(`one approval cleans all historical groups: ${scenario}`, async ({ page, wallet, guards }) => {
    const owner = new PublicKey(wallet.address);
    const mints = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const receipts = await Promise.all([0, 1, 2].map(async group => ({ wallet: wallet.address,
      positionMint: Keypair.generate().publicKey.toBase58(), sourceSignature: bs58.encode(new Uint8Array(64).fill(10 + group)),
      compoundAccounts: await Promise.all([0, 1].map(async leg => {
        const seed = `${group}${leg}`.repeat(11);
        return { seed, address: (await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID)).toBase58(),
          mint: mints[leg]!.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), space: 165, rentLamports: 2_039_280 };
      })),
    })));
    await page.route("**/api/compound-recover-discover", route => route.fulfill({ json: {
      wallet: wallet.address, receipts, scanned: 6, totalCandidates: 6, incomplete: false, errors: 0, nextCursor: null,
    } }));
    let prepareCount = 0;
    await page.route("**/api/compound-cleanup-prepare", route => {
      prepareCount++;
      const body = route.request().postDataJSON();
      const accounts = body.compoundAccounts as typeof receipts[number]["compoundAccounts"];
      const groups = scenario === "chunked" ? [accounts.slice(0, 3), accounts.slice(3)] : [accounts];
      const transactions = groups.map(group => {
        const blockhash = Keypair.generate().publicKey.toBase58();
        const summaryAccounts = group.map(account => ({ ...account, amount: "1", decimals: 6,
          sourceLamports: account.rentLamports,
          destination: getAssociatedTokenAddressSync(new PublicKey(account.mint), owner, false, TOKEN_PROGRAM_ID).toBase58() }));
        const instructions = summaryAccounts.flatMap(account => {
          const source = new PublicKey(account.address), mint = new PublicKey(account.mint), destination = new PublicKey(account.destination);
          return [createAssociatedTokenAccountIdempotentInstruction(owner, destination, owner, mint),
            createTransferCheckedInstruction(source, mint, destination, owner, 1n, 6),
            createCloseAccountInstruction(source, owner, owner)];
        });
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions }).compileToV0Message());
        return { permit: "a".repeat(64), unsignedTransaction: Buffer.from(tx.serialize()).toString("base64"),
          summary: { operation: "recovery", simulated: true, wallet: wallet.address, blockhash, lastValidBlockHeight: 150,
            expiresAt: Date.now() + 60_000, feeLamports: 5000, sizeBytes: tx.serialize().length, compoundAccounts: summaryAccounts } };
      });
      return route.fulfill({ json: { wallet: wallet.address, alreadyClosed: [], transactions } });
    });
    const broadcasts: string[] = [];
    await page.route("**/api/compound-cleanup-broadcast", route => {
      const body = route.request().postDataJSON();
      const tx = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
      expect(FakeWallet.verify(wallet.address, tx.message.serialize(), tx.signatures[0]!)).toBe(true);
      const signature = bs58.encode(tx.signatures[0]!);
      broadcasts.push(signature);
      return route.fulfill({ json: { signature } });
    });
    const confirmations = new Map<string, number>();
    if (scenario === "interrupted-confirmation") guards.allowConsole(/Failed to load resource: net::ERR_FAILED/);
    await page.route("**/api/compound-cleanup-confirm", route => {
      const { signature } = route.request().postDataJSON();
      const count = (confirmations.get(signature) ?? 0) + 1;
      confirmations.set(signature, count);
      if (scenario === "interrupted-confirmation" && count === 1) return route.abort("failed");
      const pending = count <= 2;
      return route.fulfill({ json: { signature, status: pending ? "pending" : "success", chainStatus: pending ? "pending" : "success" } });
    });
    // `/app` also lists pools (Solana + Robinhood Chain); this journey is about cleanup, so the pool list is empty.
    await page.route("**/api/rwa-pairs**", route => route.fulfill({ json: { pairs: [] } }));
    await page.route("**/api/protocol-pools**", route => route.fulfill({ json: { pairs: [], pools: [] } }));
    await page.goto("/app", { waitUntil: "domcontentloaded" });
    await new ConnectModal(page, wallet).connect();
    await expect(page.getByRole("heading", { name: "Clean up leftover yield" })).toBeVisible();
    await page.getByRole("button", { name: "Find leftover yield" }).click();
    await expect(page.getByText(/Wallet scan complete/)).toBeVisible();
    await page.getByRole("button", { name: /Clean up all balances \(3\)/ }).click();
    await expect(page.getByText(/All selected yield accounts cleaned up/)).toBeVisible({ timeout: 40_000 });
    await expect(page.getByRole("button", { name: /Clean up all balances \(0\)/ })).toBeDisabled();
    expect(broadcasts).toHaveLength(scenario === "chunked" ? 2 : 1);
    expect(new Set(broadcasts).size).toBe(broadcasts.length);
    expect(wallet.signedTransactions).toHaveLength(broadcasts.length);
    expect(await page.evaluate(() => (window as unknown as { __E2E_SIGN_REQUESTS__: number[] }).__E2E_SIGN_REQUESTS__)).toEqual([broadcasts.length]);
    expect(prepareCount).toBe(1);
    await page.screenshot({ path: test.info().outputPath(`cleanup-${scenario}-complete.png`), fullPage: true });
  });
}
