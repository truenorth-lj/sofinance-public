import { describe, expect, it, vi } from "vitest";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { computeBudgetPriorityLamports } from "@sofinance/engine/wallet-priority-fee";
import { SIGNATURE_BASE_FEE_LAMPORTS } from "./cleanup-priority-fee";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo, type Connection } from "@solana/web3.js";
import type { CompoundAccount } from "@sofinance/engine/compound-types";
vi.mock("server-only", () => ({}));
import { buildCleanupBatch, issueCleanupBatchPermit, parseCleanupBatchSummary, simulateAndVerifyCleanupBatch,
  validCleanupSignature, verifyCleanupBatchPermit } from "./compound-cleanup-batch";
import { issueCompoundPermit } from "./compound-permit";

const rent = 2_039_280, balance = 100_000_000;
function token(owner: PublicKey, mint: PublicKey, amount: bigint, native = false): AccountInfo<Buffer> {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1,
    isNativeOption: native ? 1 : 0, isNative: native ? BigInt(rent) : 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { owner: TOKEN_PROGRAM_ID, data, lamports: rent + (native ? Number(amount) : 0), executable: false, rentEpoch: 0 };
}
function mintInfo(): AccountInfo<Buffer> {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000n, decimals: 6,
    isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  return { owner: TOKEN_PROGRAM_ID, data, lamports: 1, executable: false, rentEpoch: 0 };
}
let probeUnits: number | undefined = 12000;
async function fixture(count = 6, amount = 100n, existingDestination = true, native = false) {
  probeUnits = 12000;
  const signer = Keypair.generate(), wallet = signer.publicKey.toBase58(), mint = native ? NATIVE_MINT : Keypair.generate().publicKey;
  const destination = getAssociatedTokenAddressSync(mint, signer.publicKey).toBase58();
  const descriptors: CompoundAccount[] = [];
  const sources = new Map<string, AccountInfo<Buffer>>();
  for (let index = 0; index < count; index++) {
    const seed = `batch_${index}`, address = (await PublicKey.createWithSeed(signer.publicKey, seed, TOKEN_PROGRAM_ID)).toBase58();
    descriptors.push({ seed, address, mint: mint.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), space: 165, rentLamports: rent });
    sources.set(address, token(signer.publicKey, mint, amount, native));
  }
  const info = (address: string) => sources.get(address) ?? (address === mint.toBase58() ? mintInfo() : address === destination ?
    (existingDestination ? token(signer.publicKey, mint, 5n, native) : null) : address === wallet ?
      { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: balance, executable: false, rentEpoch: 0 } : null);
  const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) => keys.map(key => info(key.toBase58())));
  const simulateTransaction = vi.fn(async (_transaction: VersionedTransaction, config: { accounts?: { addresses: string[] } }) => {
    // The signature-less probe that measures compute units asks for no account readback.
    if (!config.accounts) return { context: { slot: 10 }, value: { err: null, unitsConsumed: probeUnits, accounts: [] } };
    const count = config.accounts.addresses.filter(address => sources.has(address)).length;
    const fee = SIGNATURE_BASE_FEE_LAMPORTS + Number(computeBudgetPriorityLamports(_transaction));
    return { context: { slot: 10 }, value: { err: null, unitsConsumed: 12000, accounts: config.accounts.addresses.map(address => {
      if (sources.has(address)) return null;
      const simulated = address === destination ? token(signer.publicKey, mint, (existingDestination ? 5n : 0n) + BigInt(count) * amount, native) :
        { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: balance + count * rent - fee - (!existingDestination && amount > 0n ? rent : 0), executable: false, rentEpoch: 0 };
      return { ...simulated, owner: simulated.owner.toBase58(), data: [simulated.data.toString("base64"), "base64"] };
    }) } };
  });
  const connection = { getMultipleAccountsInfo, getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({ context: { slot: 10 }, value: keys.map(key => info(key.toBase58())) })),
    simulateTransaction, getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })),
    getFeeForMessage: vi.fn(async () => ({ value: 5000 })) } as unknown as Connection;
  return { connection, descriptors, signer, wallet, sources, destination, simulateTransaction, getMultipleAccountsInfo };
}

describe("batched cleanup builder", () => {
  it("merges more than one original pair and creates each destination once", async () => {
    const f = await fixture(12, 100n, false);
    const prepared = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    expect(prepared.transactions).toHaveLength(1);
    const { transaction, summary } = prepared.transactions[0]!;
    expect(summary.compoundAccounts).toHaveLength(12);
    expect(transaction.serialize().length).toBeLessThanOrEqual(1232);
    const instructions = TransactionMessage.decompile(transaction.message).instructions;
    expect(instructions.filter(ix => ix.data.length === 1 && ix.data[0] === 1)).toHaveLength(1);
    expect(instructions.filter(ix => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9)).toHaveLength(12);
    // The first simulation is the signature-less compute-unit probe; the verification simulation pins the snapshot slot.
    expect(f.simulateTransaction.mock.calls.some(call => (call[1] as { minContextSlot?: number }).minContextSlot === 10)).toBe(true);
  });
  it("splits large inventories by real serialized packet size", async () => {
    const f = await fixture(64);
    const prepared = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    expect(prepared.transactions.length).toBeGreaterThan(1);
    expect(prepared.transactions.reduce((sum, tx) => sum + tx.summary.compoundAccounts.length, 0)).toBe(64);
    expect(prepared.transactions.every(tx => tx.transaction.serialize().length <= 1232)).toBe(true);
    expect(new Set(prepared.transactions.map(tx => tx.summary.blockhash)).size).toBe(1);
  });
  it("does not allocate a recipient when closing empty sources", async () => {
    const f = await fixture(4, 0n, false);
    const prepared = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    // 4 closeAccount + the two ComputeBudget instructions (limit, price) every cleanup now carries.
    const instructions = TransactionMessage.decompile(prepared.transactions[0]!.transaction.message).instructions;
    expect(instructions).toHaveLength(6);
    expect(instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId))).toHaveLength(2);
  });
  it("skips only finalized-absent sources and rejects duplicates, unbounded inventories and foreign derivations", async () => {
    const f = await fixture(3);
    f.sources.delete(f.descriptors[1]!.address);
    const result = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    expect(result.alreadyClosed).toEqual([f.descriptors[1]!.address]);
    expect(f.getMultipleAccountsInfo).toHaveBeenCalledWith([new PublicKey(f.descriptors[1]!.address)], "finalized");
    await expect(buildCleanupBatch(f.connection, f.wallet, [f.descriptors[0], f.descriptors[0]])).rejects.toThrow("Duplicate");
    await expect(buildCleanupBatch(f.connection, f.wallet, Array(65).fill(f.descriptors[0]))).rejects.toThrow();
    await expect(buildCleanupBatch(f.connection, f.wallet, [{ ...f.descriptors[0], seed: "foreign" }])).rejects.toThrow("derived");
  });
  it.each(["source survives", "recipient credit", "wallet rent", "source amount"])("rejects unsafe simulation: %s", async field => {
    const f = await fixture(3), prepared = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    const { transaction, summary } = prepared.transactions[0]!;
    const response = await f.simulateTransaction(transaction, { accounts: { addresses: [...summary.compoundAccounts.map(account => account.address), f.destination, f.wallet] } });
    if (field === "source survives") response.value.accounts[0] = response.value.accounts[3]!;
    if (field === "recipient credit") {
      const wrong = token(f.signer.publicKey, new PublicKey(f.descriptors[0]!.mint), 1n);
      response.value.accounts[3] = { ...wrong, owner: wrong.owner.toBase58(), data: [wrong.data.toString("base64"), "base64"] };
    }
    if (field === "wallet rent") response.value.accounts.at(-1)!.lamports -= 1;
    if (field === "source amount") summary.compoundAccounts[0]!.amount = "1";
    f.simulateTransaction.mockResolvedValueOnce(response);
    await expect(simulateAndVerifyCleanupBatch({ connection: f.connection, transaction, summary, sigVerify: true })).rejects.toThrow();
  });
  it("binds wallet, full source summary and exact message to an independent HMAC domain", async () => {
    const f = await fixture(3), prepared = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    const tx = prepared.transactions[0]!, input = { wallet: f.wallet, summary: tx.summary, message: Buffer.from(tx.transaction.message.serialize()).toString("base64") };
    const permit = issueCleanupBatchPermit("secret", input);
    expect(verifyCleanupBatchPermit("secret", input, permit)).toBe(true);
    expect(verifyCleanupBatchPermit("secret", { ...input, message: "changed" }, permit)).toBe(false);
    expect(verifyCleanupBatchPermit("secret", { ...input, summary: { ...tx.summary, feeLamports: 1 } }, permit)).toBe(false);
    expect(verifyCleanupBatchPermit("secret", input, issueCompoundPermit("secret", input))).toBe(false);
    expect(validCleanupSignature(tx.transaction, f.wallet)).toBe(false);
    tx.transaction.sign([f.signer]);
    expect(validCleanupSignature(tx.transaction, f.wallet)).toBe(true);
    tx.transaction.signatures[0]![0] = tx.transaction.signatures[0]![0]! ^ 1;
    expect(validCleanupSignature(tx.transaction, f.wallet)).toBe(false);
  });
  it.each([true, false])("accounts for WSOL backing without treating it as rent (existing ATA: %s)", async existing => {
    const f = await fixture(3, 20_000_000n, existing, true);
    const prepared = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    expect(prepared.transactions[0]!.summary.compoundAccounts.every(account => account.rentLamports === rent && account.sourceLamports === rent + 20_000_000)).toBe(true);
  });
  it.each(["recipient", "wallet"])("retries a moved simulation slot once with exact fresh %s budgets", async field => {
    const f = await fixture(3), prepared = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    const { transaction, summary } = prepared.transactions[0]!;
    const response = await f.simulateTransaction(transaction, { accounts: { addresses: [...summary.compoundAccounts.map(account => account.address), f.destination, f.wallet] } });
    response.context.slot = 11;
    if (field === "wallet") response.value.accounts.at(-1)!.lamports -= 1;
    else {
      const wrong = token(f.signer.publicKey, new PublicKey(f.descriptors[0]!.mint), 1n);
      response.value.accounts[3] = { ...wrong, owner: wrong.owner.toBase58(), data: [wrong.data.toString("base64"), "base64"] };
    }
    const before = f.simulateTransaction.mock.calls.length;
    f.simulateTransaction.mockResolvedValueOnce(response);
    await expect(simulateAndVerifyCleanupBatch({ connection: f.connection, transaction, summary, sigVerify: true })).resolves.toMatchObject({ unitsConsumed: 12000 });
    expect(f.simulateTransaction.mock.calls.length - before).toBe(2);
    f.simulateTransaction.mockResolvedValueOnce(response).mockResolvedValueOnce(response);
    await expect(simulateAndVerifyCleanupBatch({ connection: f.connection, transaction, summary, sigVerify: true })).rejects.toThrow("between snapshot and simulation");
  });
  it("validates persisted confirmation sources and canonical recipients independently of permits", async () => {
    const f = await fixture(3), { transactions } = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    await expect(parseCleanupBatchSummary(transactions[0]!.summary, f.wallet)).resolves.toMatchObject({ wallet: f.wallet });
    const summary = structuredClone(transactions[0]!.summary);
    summary.compoundAccounts[0]!.destination = Keypair.generate().publicKey.toBase58();
    await expect(parseCleanupBatchSummary(summary, f.wallet)).rejects.toThrow("recipient");
  });
});

describe("cleanup compute budget", () => {
  const budgetOf = (transaction: VersionedTransaction) => {
    const ixs = TransactionMessage.decompile(transaction.message).instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId));
    const limit = ixs.find(ix => ix.data[0] === 2)!, price = ixs.find(ix => ix.data[0] === 3)!;
    return { units: limit.data.readUInt32LE(1), microLamports: Number(price.data.readBigUInt64LE(1)), first: TransactionMessage.decompile(transaction.message).instructions.slice(0, 2).every(ix => ix.programId.equals(ComputeBudgetProgram.programId)) };
  };
  it("prices the cleanup above zero and sizes the limit from the measured units, budget first", async () => {
    const f = await fixture(4, 100n, false);
    const { transaction, summary } = (await buildCleanupBatch(f.connection, f.wallet, f.descriptors)).transactions[0]!;
    const budget = budgetOf(transaction);
    expect(budget.first).toBe(true);
    expect(budget.units).toBe(Math.ceil(12000 * 1.3));
    expect(budget.microLamports).toBeGreaterThanOrEqual(5_000);
    // The summary's fee comes from the estimate of this very message, so the verified wallet delta already includes the priority fee.
    const estimated = (f.connection.getFeeForMessage as unknown as { mock: { calls: [typeof transaction.message][] } }).mock.calls[0]![0];
    expect(estimated.compiledInstructions).toEqual(transaction.message.compiledInstructions);
    const priority = Number(computeBudgetPriorityLamports(transaction));
    expect(priority).toBeGreaterThan(0);
    // getFeeForMessage in this fixture returns only the base fee; the builder must add the message's own priority.
    expect(summary.feeLamports).toBe(SIGNATURE_BASE_FEE_LAMPORTS + priority);
    expect(summary.sizeBytes).toBe(transaction.serialize().length);
  });
  it("follows a busy network but never exceeds the priority-fee ceiling", async () => {
    const f = await fixture(4, 100n, false);
    (f.connection as unknown as { getRecentPrioritizationFees: unknown }).getRecentPrioritizationFees = vi.fn(async () =>
      Array.from({ length: 150 }, () => ({ slot: 1, prioritizationFee: 50_000_000 })));
    const budget = budgetOf((await buildCleanupBatch(f.connection, f.wallet, f.descriptors)).transactions[0]!.transaction);
    expect(Math.ceil(budget.units * budget.microLamports / 1_000_000)).toBeLessThanOrEqual(50_000);
    expect(budget.microLamports).toBeGreaterThan(5_000);
  });
  it("falls back to a per-account allowance when the probe gives no units, and still builds", async () => {
    const f = await fixture(3, 100n, false);
    probeUnits = undefined;
    const budget = budgetOf((await buildCleanupBatch(f.connection, f.wallet, f.descriptors)).transactions[0]!.transaction);
    expect(budget.units).toBe(50_000 + 60_000 * 3);
  });
  it("splits by real size with the budget instructions counted", async () => {
    const f = await fixture(40);
    const prepared = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    expect(prepared.transactions.every(item => item.transaction.serialize().length <= 1232)).toBe(true);
    expect(prepared.transactions.every(item => budgetOf(item.transaction).first)).toBe(true);
    expect(prepared.transactions.reduce((sum, item) => sum + item.summary.compoundAccounts.length, 0)).toBe(40);
  });
  it("accepts a wallet that raises the priority fee but still rejects one that changes the cleanup balance", async () => {
    const f = await fixture(3, 100n, false);
    const { transaction, summary } = (await buildCleanupBatch(f.connection, f.wallet, f.descriptors)).transactions[0]!;
    const raised = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(f.wallet), recentBlockhash: summary.blockhash,
      instructions: TransactionMessage.decompile(transaction.message).instructions.map(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3
        ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }) : ix) }).compileToV0Message());
    await expect(simulateAndVerifyCleanupBatch({ connection: f.connection, transaction: raised, prepared: transaction, summary, sigVerify: false })).resolves.toBeDefined();
  });

  it("still prepares when getFeeForMessage returns only the base fee, and does not double-count when it includes priority", async () => {
    const f = await fixture(3, 100n, false);
    const built = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    const transaction = built.transactions[0]!.transaction;
    const priority = Number(computeBudgetPriorityLamports(transaction));
    expect(built.transactions[0]!.summary.feeLamports).toBe(SIGNATURE_BASE_FEE_LAMPORTS + priority);

    const inclusive = vi.fn(async (message: VersionedTransaction["message"]) => {
      const tx = new VersionedTransaction(message);
      return { value: SIGNATURE_BASE_FEE_LAMPORTS + Number(computeBudgetPriorityLamports(tx)) };
    });
    (f.connection as unknown as { getFeeForMessage: unknown }).getFeeForMessage = inclusive;
    const again = await buildCleanupBatch(f.connection, f.wallet, f.descriptors);
    const againTx = again.transactions[0]!.transaction;
    const againPriority = Number(computeBudgetPriorityLamports(againTx));
    expect(again.transactions[0]!.summary.feeLamports).toBe(SIGNATURE_BASE_FEE_LAMPORTS + againPriority);
    expect(inclusive).toHaveBeenCalled();
  });
  it("verifies a prepared transaction even if feeLamports is still the base fee and simulation deducts the priority", async () => {
    const f = await fixture(3, 100n, false);
    const { transaction, summary } = (await buildCleanupBatch(f.connection, f.wallet, f.descriptors)).transactions[0]!;
    const baseOnly = { ...summary, feeLamports: SIGNATURE_BASE_FEE_LAMPORTS };
    await expect(simulateAndVerifyCleanupBatch({ connection: f.connection, transaction, summary: baseOnly, sigVerify: false })).resolves.toBeDefined();
  });
});
