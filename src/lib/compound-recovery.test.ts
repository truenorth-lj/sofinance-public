import { describe, expect, it, vi } from "vitest";
import { AccountLayout, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type AccountInfo, type Connection } from "@solana/web3.js";
import type { CompoundAccount } from "./compound-types";
import type { CompoundRecoverySummary } from "./compound-recovery-types";
vi.mock("server-only", () => ({}));
import { readRecoveryAccounts, simulateAndVerifyRecovery } from "./compound-recovery";

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
  it("closes a zero-yield account without allocating a new ATA", async () => {
    const { connection, transaction, summary, simulateTransaction } = await fixture(0n);
    await simulateAndVerifyRecovery({ connection, transaction, summary, sigVerify: false });
    expect(simulateTransaction.mock.calls[0]![1].accounts.addresses).toEqual([summary.compoundAccounts[0]!.address, summary.wallet]);
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
