import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { compoundAttemptKey, compoundReceiptsKey, loadCompoundAttempt, loadCompoundReceipts,
  parseCompoundAttempt, persistCompoundAttempt, persistCompoundReceipt, removeConsumedCompoundReceipts, removeRecoveredReceipt, signedCompoundTransaction,
  type CompoundAttempt } from "./compound-attempt";
import type { CompoundSummary } from "./compound-types";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

const key = () => Keypair.generate().publicKey.toBase58();
function memoryStorage() {
  const values = new Map<string, string>();
  const writes: string[] = [];
  return { values, writes, getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { writes.push(name); values.set(name, value); } };
}
function attempt(wallet = key()): CompoundAttempt & { kind: "compound" } {
  const positionMint = key();
  const summary = { operation: "compound", simulated: true, state: { wallet, mintA: key(), mintB: key(), decimalsA: 6, decimalsB: 8,
    nftAta: key(), programId: key(), vaultA: key(), vaultB: key(), rewards: [] }, positionMint,
    positionAccount: key(), poolId: key(), liquidity: "100", blockhash: key(),
    startingLiquidity: "200", amountMaxA: "10", amountMaxB: "20", simulatedEndingLiquidity: "300",
    simulatedDustA: "1", simulatedDustB: "2", simulatedSolDebitLamports: "4000000", maxSolDebitLamports: "5000000",
    simulatedHarvest: { a: "10", b: "20" }, simulatedRewards: [], feeLamports: 5000, rentLamports: 4_078_560, sizeBytes: 400, simulatedAt: Date.now(),
    lastValidBlockHeight: 123, expiresAt: Date.now() + 30_000,
    compoundAccounts: [0, 1].map((i) => ({ seed: String(i).repeat(32), address: key(), mint: key(),
      program: TOKEN_PROGRAM_ID.toBase58(), space: 165, rentLamports: 2_039_280 })) } as unknown as CompoundSummary;
  return { version: 1, wallet, positionMint, signature: bs58.encode(Keypair.generate().secretKey),
    createdAt: Date.now(), kind: "compound", summary };
}

describe("compound signature and recovery persistence", () => {
  it("writes receipt seeds and signed identity before a caller can broadcast", () => {
    const storage = memoryStorage();
    const current = attempt();
    persistCompoundAttempt(storage, current);
    expect(storage.writes).toEqual([compoundReceiptsKey(current.wallet), compoundAttemptKey(current.wallet)]);
    expect(loadCompoundAttempt(storage, current.wallet).attempt).toEqual(current);
    expect(loadCompoundReceipts(storage, current.wallet).receipts[0]).toMatchObject({
      sourceSignature: current.signature, compoundAccounts: current.summary.compoundAccounts });
  });

  it("retains prior dust accounts when a later compound replaces a terminal attempt", () => {
    const storage = memoryStorage();
    const first = attempt();
    const second = attempt(first.wallet);
    persistCompoundAttempt(storage, first);
    persistCompoundAttempt(storage, second);
    expect(loadCompoundAttempt(storage, first.wallet).attempt?.signature).toBe(second.signature);
    expect(loadCompoundReceipts(storage, first.wallet).receipts.map((item) => item.sourceSignature))
      .toEqual([first.signature, second.signature]);
  });

  it("fails closed when receipt writes are silently lost without overwriting a prior signature", () => {
    const storage = memoryStorage();
    const first = attempt();
    persistCompoundAttempt(storage, first);
    const second = attempt(first.wallet);
    const unavailable = { getItem: storage.getItem, setItem: () => undefined };
    expect(() => persistCompoundAttempt(unavailable, second)).toThrow("Unable to save yield account record");
    expect(loadCompoundAttempt(storage, first.wallet).attempt?.signature).toBe(first.signature);
    expect(loadCompoundReceipts(storage, first.wallet).receipts).toHaveLength(1);
  });

  it("rejects wallet mismatches and corrupt storage while preserving raw evidence", () => {
    const storage = memoryStorage();
    const current = attempt();
    expect(parseCompoundAttempt(current, key())).toBeNull();
    expect(parseCompoundAttempt({ ...current, summary: { ...current.summary, positionMint: key() } }, current.wallet)).toBeNull();
    storage.setItem(compoundAttemptKey(current.wallet), "{truncated");
    expect(loadCompoundAttempt(storage, current.wallet)).toEqual({ attempt: null, invalid: true });
    expect(storage.getItem(compoundAttemptKey(current.wallet))).toBe("{truncated");
  });

  it("rejects incomplete stored summaries instead of crashing the panel", () => {
    const current = attempt();
    expect(parseCompoundAttempt({ ...current, summary: { ...current.summary, simulatedHarvest: undefined } }, current.wallet)).toBeNull();
    expect(parseCompoundAttempt({ ...current, summary: { ...current.summary, state: { ...current.summary.state, decimalsA: undefined } } }, current.wallet)).toBeNull();
    expect(parseCompoundAttempt({ ...current, summary: { ...current.summary, simulatedDustA: "NaN" } }, current.wallet)).toBeNull();
  });

  it("accepts a net SOL rent refund while rejecting negative token budgets", () => {
    const current = attempt();
    current.summary.simulatedSolDebitLamports = "-2000000";
    expect(parseCompoundAttempt(current, current.wallet)).toEqual(current);
    expect(parseCompoundAttempt({ ...current, summary: { ...current.summary, simulatedSolDebitLamports: "--1" } }, current.wallet)).toBeNull();
    expect(parseCompoundAttempt({ ...current, summary: { ...current.summary, amountMaxA: "-1" } }, current.wallet)).toBeNull();
    expect(parseCompoundAttempt({ ...current, summary: { ...current.summary, maxSolDebitLamports: "-1" } }, current.wallet)).toBeNull();
  });

  it("restores compact base64url seeds and remains compatible with prior hexadecimal seeds", () => {
    const current = attempt();
    current.summary.compoundAccounts[0].seed = "k57m8ADnbHCuFiMP_rT-AA";
    expect(parseCompoundAttempt(current, current.wallet)).toEqual(current);
    current.summary.compoundAccounts[0].seed = "contains invalid spaces";
    expect(parseCompoundAttempt(current, current.wallet)).toBeNull();
  });

  it("restores validated swap previews and rejects malformed stored swap or prior-yield fields", () => {
    const current = attempt();
    current.summary.swaps = [{ inputMint: current.summary.state.mintB, outputMint: current.summary.state.mintA,
      inputAmount: "20", minOutputAmount: "17", quotedOutputAmount: "18", simulatedOutputAmount: "18",
      inputDecimals: 8, outputDecimals: 6, poolId: current.summary.poolId, sqrtPriceAfterX64: "18446744073709551616" }];
    current.summary.priorSources = [{ sourceSignature: bs58.encode(Keypair.generate().secretKey), address: key(),
      mint: current.summary.state.mintB, program: TOKEN_PROGRAM_ID.toBase58(), amount: "20", destination: key(), refundLamports: 2_039_280 }];
    expect(parseCompoundAttempt(current, current.wallet)).toEqual(current);
    expect(parseCompoundAttempt({ ...current, summary: { ...current.summary, swaps: [{ ...current.summary.swaps[0], minOutputAmount: "NaN" }] } }, current.wallet)).toBeNull();
    expect(parseCompoundAttempt({ ...current, summary: { ...current.summary, priorSources: [{ ...current.summary.priorSources[0], amount: undefined }] } }, current.wallet)).toBeNull();
  });

  it("retains source receipts before confirmation and removes only consumed sources after confirmation", () => {
    const storage = memoryStorage();
    const consumed = attempt();
    const unrelated = attempt(consumed.wallet);
    const newest = attempt(consumed.wallet);
    newest.positionMint = consumed.positionMint;
    newest.summary.positionMint = consumed.positionMint;
    newest.summary.priorSources = consumed.summary.compoundAccounts.map((account) => ({
      sourceSignature: consumed.signature, address: account.address, mint: account.mint, program: account.program,
      amount: "10", destination: newest.summary.compoundAccounts[0].address, refundLamports: account.rentLamports,
    }));
    persistCompoundAttempt(storage, consumed);
    persistCompoundAttempt(storage, unrelated);
    persistCompoundAttempt(storage, newest);
    expect(loadCompoundReceipts(storage, consumed.wallet).receipts.map((receipt) => receipt.sourceSignature))
      .toEqual([consumed.signature, unrelated.signature, newest.signature]);
    removeConsumedCompoundReceipts(storage, newest);
    expect(loadCompoundReceipts(storage, consumed.wallet).receipts.map((receipt) => receipt.sourceSignature))
      .toEqual([unrelated.signature, newest.signature]);
    expect(loadCompoundAttempt(storage, consumed.wallet).attempt?.signature).toBe(newest.signature);
  });

  it("does not discard evidence if consumed receipt storage cannot be updated", () => {
    const storage = memoryStorage();
    const current = attempt();
    persistCompoundAttempt(storage, current);
    const next = attempt(current.wallet);
    next.summary.priorSources = [{ sourceSignature: current.signature, address: current.summary.compoundAccounts[0].address,
      mint: current.summary.compoundAccounts[0].mint, program: TOKEN_PROGRAM_ID.toBase58(), amount: "1",
      destination: next.summary.compoundAccounts[0].address, refundLamports: 2_039_280 }];
    removeConsumedCompoundReceipts(storage, next);
    expect(loadCompoundReceipts(storage, current.wallet).receipts[0]?.sourceSignature).toBe(current.signature);
    next.summary.priorSources.push({ ...next.summary.priorSources[0]!, address: current.summary.compoundAccounts[1].address });
    expect(() => removeConsumedCompoundReceipts({ getItem: storage.getItem, setItem: () => undefined }, next)).toThrow("unable to update");
    expect(loadCompoundReceipts(storage, current.wallet).receipts[0]?.sourceSignature).toBe(current.signature);
  });

  it("imports deduplicated recovery accounts without replacing the submitted signature", () => {
    const storage = memoryStorage();
    const current = attempt();
    const imported = attempt(current.wallet);
    persistCompoundAttempt(storage, current);
    const receipt = { wallet: imported.wallet, positionMint: imported.positionMint,
      sourceSignature: imported.signature, compoundAccounts: imported.summary.compoundAccounts };
    persistCompoundReceipt(storage, receipt);
    persistCompoundReceipt(storage, receipt);
    expect(loadCompoundReceipts(storage, current.wallet).receipts).toHaveLength(2);
    expect(loadCompoundAttempt(storage, current.wallet).attempt?.signature).toBe(current.signature);
    storage.setItem(compoundReceiptsKey(current.wallet), "{corrupt");
    expect(() => persistCompoundReceipt(storage, receipt)).toThrow("cannot be read");
    expect(storage.getItem(compoundReceiptsKey(current.wallet))).toBe("{corrupt");
  });

  it("removes only a successfully recovered source receipt and retains later dust", () => {
    const storage = memoryStorage();
    const first = attempt();
    const later = attempt(first.wallet);
    persistCompoundAttempt(storage, first);
    persistCompoundAttempt(storage, later);
    const recovery: CompoundAttempt = { ...first, kind: "recovery", sourceSignature: first.signature,
      summary: { operation: "recovery", simulated: true, wallet: first.wallet,
        compoundAccounts: first.summary.compoundAccounts.map((item) => ({ ...item, amount: "1", decimals: 6,
          destination: key(), sourceLamports: item.rentLamports })),
        feeLamports: 5_000, sizeBytes: 400, blockhash: key(), lastValidBlockHeight: 123,
        expiresAt: Date.now() + 30_000 } };
    expect(parseCompoundAttempt(recovery, first.wallet)).toEqual(recovery);
    persistCompoundAttempt(storage, recovery);
    expect(loadCompoundReceipts(storage, first.wallet).receipts).toHaveLength(2);
    removeRecoveredReceipt(storage, recovery);
    expect(loadCompoundReceipts(storage, first.wallet).receipts.map((item) => item.sourceSignature)).toEqual([later.signature]);
  });

  it("detects a wallet mutating the supplied transaction, using the pre-sign snapshot", () => {
    const owner = Keypair.generate();
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey,
      recentBlockhash: key(), instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey,
        toPubkey: Keypair.generate().publicKey, lamports: 1 })] }).compileToV0Message());
    const original = Uint8Array.from(transaction.message.serialize());
    expect(() => signedCompoundTransaction(transaction, original, owner.publicKey.toBase58())).toThrow("did not return transaction signature");
    transaction.sign([owner]);
    const signed = signedCompoundTransaction(transaction, original, owner.publicKey.toBase58());
    expect(signed.signature).toBe(bs58.encode(transaction.signatures[0]!));
    transaction.message.recentBlockhash = key();
    expect(() => signedCompoundTransaction(transaction, original, owner.publicKey.toBase58())).toThrow("modified transaction content");
  });
});
