import { describe, expect, it, vi } from "vitest";
import { AccountLayout, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo, type Connection } from "@solana/web3.js";
import type { CompoundAccount } from "./compound-types";
import type { CompoundRecoverySummary } from "./compound-recovery-types";
import { buildAndSimulateCompoundRecovery, readRecoveryAccounts, simulateAndVerifyRecovery } from "./compound-recovery";
import { computeBudgetPriorityLamportsCharged } from "./wallet-priority-fee";
import { SIGNATURE_BASE_FEE_LAMPORTS } from "./tx-priority-fee";

const rent = 2_039_280;
function tokenInfo(owner: PublicKey, amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint: NATIVE_MINT, owner, amount, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 1, isNative: BigInt(rent), delegatedAmount: 0n,
    closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { owner: TOKEN_PROGRAM_ID, data, lamports: rent + Number(amount), executable: false, rentEpoch: 0 };
}
function mintInfo(): AccountInfo<Buffer> {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 0n,
    decimals: 9, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  return { owner: TOKEN_PROGRAM_ID, data, lamports: 1, executable: false, rentEpoch: 0 };
}
async function fixture(amount = 20_000_000n) {
  const owner = Keypair.generate().publicKey;
  const seed = "a".repeat(32);
  const address = await PublicKey.createWithSeed(owner, seed, TOKEN_PROGRAM_ID);
  const descriptor: CompoundAccount = { seed, address: address.toBase58(), mint: NATIVE_MINT.toBase58(),
    program: TOKEN_PROGRAM_ID.toBase58(), space: 165, rentLamports: rent };
  const source = tokenInfo(owner, amount);
  let destination = "";
  const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) => keys.map((key) => key.equals(address) ? source :
    key.equals(NATIVE_MINT) ? mintInfo() : key.toBase58() === destination ? tokenInfo(owner, 4_000_000n) : null));
  const simulateTransaction = vi.fn(async (_transaction: VersionedTransaction, config: { accounts: { addresses: string[] } }) => ({ value: {
    err: null, unitsConsumed: 2000, accounts: config.accounts.addresses.map((key) => {
      if (key === address.toBase58()) return null;
      const info = key === owner.toBase58() ? { owner: PublicKey.default, lamports: 100_000_000 + rent - 5000,
        data: Buffer.alloc(0), executable: false, rentEpoch: 0 } : tokenInfo(owner, 4_000_000n + amount);
      return { ...info, owner: info.owner.toBase58(), data: [info.data.toString("base64"), "base64"] };
    }),
  } }));
  const connection = { getMultipleAccountsInfo, simulateTransaction, getBalance: vi.fn(async () => 100_000_000) } as unknown as Connection;
  const accounts = await readRecoveryAccounts(connection, owner.toBase58(), [descriptor]);
  destination = accounts[0]!.destination;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [] }).compileToV0Message());
  const summary: CompoundRecoverySummary = { operation: "recovery", simulated: true, wallet: owner.toBase58(), compoundAccounts: accounts,
    blockhash, lastValidBlockHeight: 1, expiresAt: Date.now() + 30_000, feeLamports: 5000, sizeBytes: 100 };
  return { connection, descriptor, source, owner, transaction, summary, simulateTransaction };
}

describe("owner-controlled leftover recovery", () => {
  it("returns only WSOL rent to SOL; backing lamports travel to the token ATA", async () => {
    const { connection, transaction, summary } = await fixture();
    expect(summary.compoundAccounts[0]).toMatchObject({ amount: "20000000", sourceLamports: rent + 20_000_000, rentLamports: rent });
    await expect(simulateAndVerifyRecovery({ connection, transaction, summary, sigVerify: false })).resolves.toEqual({ unitsConsumed: 2000 });
  });
  it("closes a zero-harvest account without allocating a new ATA", async () => {
    const { connection, transaction, summary, simulateTransaction } = await fixture(0n);
    await simulateAndVerifyRecovery({ connection, transaction, summary, sigVerify: false });
    expect(simulateTransaction.mock.calls[0]![1].accounts.addresses).toEqual([summary.compoundAccounts[0]!.address, summary.wallet]);
  });
  it.each([false, true])("accepts RPC's emptied system-account representation (zero yield: %s)", async zeroYield => {
    const f = await fixture(zeroYield ? 0n : 20_000_000n);
    const addresses = [f.descriptor.address, ...(!zeroYield ? [f.summary.compoundAccounts[0]!.destination] : []), f.summary.wallet];
    const result = await f.simulateTransaction(f.transaction, { accounts: { addresses } });
    result.value.accounts[0] = { owner: SystemProgram.programId.toBase58(), lamports: 0, data: ["", "base64"], executable: false, rentEpoch: 0 };
    f.simulateTransaction.mockResolvedValueOnce(result);
    await expect(simulateAndVerifyRecovery({ ...f, sigVerify: false })).resolves.toEqual({ unitsConsumed: 2000 });
  });
  it.each(["funded", "data", "token-owned", "executable"])("rejects an account that remains %s after simulated recovery", async field => {
    const f = await fixture();
    const result = await f.simulateTransaction(f.transaction, { accounts: { addresses: [f.descriptor.address, f.summary.compoundAccounts[0]!.destination, f.summary.wallet] } });
    result.value.accounts[0] = { owner: SystemProgram.programId.toBase58(), lamports: 0, data: ["", "base64"], executable: false, rentEpoch: 0 };
    const account = result.value.accounts[0]!;
    if (field === "funded") account.lamports = 1;
    if (field === "data") account.data = ["AQ==", "base64"];
    if (field === "token-owned") account.owner = TOKEN_PROGRAM_ID.toBase58();
    if (field === "executable") account.executable = true;
    f.simulateTransaction.mockResolvedValueOnce(result);
    await expect(simulateAndVerifyRecovery({ ...f, sigVerify: false })).rejects.toThrow("did not close");
  });
  it("rejects owner/seed tampering and stale recovery balances", async () => {
    const { connection, transaction, summary, descriptor, owner, source } = await fixture();
    await expect(readRecoveryAccounts(connection, owner.toBase58(), [{ ...descriptor, seed: "b".repeat(32) }])).rejects.toThrow("derived address");
    const modified = { ...summary, compoundAccounts: [{ ...summary.compoundAccounts[0]!, amount: "1" }] };
    await expect(simulateAndVerifyRecovery({ connection, transaction, summary: modified, sigVerify: false })).rejects.toThrow(/balance.*identity/i);
    source.data = tokenInfo(Keypair.generate().publicKey, 20_000_000n).data;
    await expect(readRecoveryAccounts(connection, owner.toBase58(), [descriptor])).rejects.toThrow("owner");
  });
});


describe("buildAndSimulateCompoundRecovery priority fee", () => {
  async function ready(amount = 20_000_000n) {
    const f = await fixture(amount);
    const feeOf = (tx: VersionedTransaction) => SIGNATURE_BASE_FEE_LAMPORTS + Number(computeBudgetPriorityLamportsCharged(tx));
    const simulateTransaction = vi.fn(async (transaction: VersionedTransaction, config?: { accounts?: { addresses: string[] } }) => {
      if (!config?.accounts) return { value: { err: null, unitsConsumed: 8_000, accounts: [] } };
      return { value: { err: null, unitsConsumed: 8_000, accounts: config.accounts.addresses.map((key) => {
        if (key === f.descriptor.address) return null;
        const info = key === f.owner.toBase58()
          ? { owner: SystemProgram.programId, lamports: 100_000_000 + rent - feeOf(transaction), data: Buffer.alloc(0), executable: false, rentEpoch: 0 }
          : tokenInfo(f.owner, 4_000_000n + amount);
        return { ...info, owner: info.owner.toBase58(), data: [info.data.toString("base64"), "base64"] };
      }) } };
    });
    const connection = {
      getMultipleAccountsInfo: f.connection.getMultipleAccountsInfo,
      simulateTransaction,
      getBalance: vi.fn(async () => 100_000_000),
      getLatestBlockhash: vi.fn(async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 })),
      getFeeForMessage: vi.fn(async () => ({ value: 5000 })),
    } as unknown as Connection;
    return { ...f, connection, simulateTransaction };
  }
  it("carries a compute budget, adds a base-only estimate's priority into feeLamports, and stays under the packet limit", async () => {
    const f = await ready();
    const { transaction, summary } = await buildAndSimulateCompoundRecovery(f.owner.toBase58(), [f.descriptor], f.connection);
    const ixs = TransactionMessage.decompile(transaction.message).instructions;
    expect(ixs.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId))).toHaveLength(2);
    expect(ixs[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    const priority = Number(computeBudgetPriorityLamportsCharged(transaction));
    expect(priority).toBeGreaterThan(0);
    expect(summary.feeLamports).toBe(SIGNATURE_BASE_FEE_LAMPORTS + priority);
    expect(transaction.serialize().length).toBeLessThanOrEqual(1232);
  });
});
