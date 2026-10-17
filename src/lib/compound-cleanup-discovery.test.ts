import { beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, type Connection, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { CompoundReceipt } from "@sofinance/engine/compound-attempt";
import { importVerifiedCompoundReceipt } from "@sofinance/engine/compound-recovery-import";
import { discoverCompoundCleanup, CLEANUP_SCAN_ACCOUNTS, CLEANUP_SCAN_HISTORY } from "./compound-cleanup-discovery";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/compound-recovery-import", () => ({ importVerifiedCompoundReceipt: vi.fn() }));
vi.mock("@sofinance/engine/swap/receipt", () => ({ compoundProtocolInstructions: vi.fn(() => [{}, {}]) }));
const key = () => Keypair.generate().publicKey;
const signature = (n = 1) => bs58.encode(new Uint8Array(64).fill(n));

function fixture(count = 2) {
  const wallet = key(), mint = key();
  const sources = Array.from({ length: count }, (_, i) => ({ address: key().toBase58(), mint: mint.toBase58(),
    program: (i % 2 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58(), seed: "a".repeat(22), space: 165, rentLamports: 1000 }));
  const receipt: CompoundReceipt = { wallet: wallet.toBase58(), positionMint: key().toBase58(), sourceSignature: signature(),
    compoundAccounts: sources.slice(0, 2).map(source => ({ ...source })) as CompoundReceipt["compoundAccounts"] };
  const token = (address: PublicKey, program: PublicKey, owner = wallet.toBase58()) => ({ pubkey: address,
    account: { owner: program, data: { parsed: { type: "account", info: { owner, mint: mint.toBase58(), tokenAmount: { amount: "0" } } } } } });
  const inventory = (program: PublicKey) => ({ value: [
    token(getAssociatedTokenAddressSync(mint, wallet, false, program), program),
    ...sources.filter(s => s.program === program.toBase58()).map(s => token(new PublicKey(s.address), program)),
  ] });
  const transaction = { transaction: { signatures: [signature()], message: { instructions: sources.map(s => ({
    programId: PublicKey.default, parsed: { type: "createAccountWithSeed", info: { newAccount: s.address } },
  })) } }, meta: { err: null } } as unknown as ParsedTransactionWithMeta;
  const getParsedTokenAccountsByOwner = vi.fn(async (_wallet: PublicKey, filter: { programId: PublicKey }) => inventory(filter.programId));
  const getSignaturesForAddress = vi.fn<Connection["getSignaturesForAddress"]>(async () =>
    [{ signature: signature(), err: null, slot: 1, memo: null, blockTime: 1, confirmationStatus: "finalized" }]);
  const getParsedTransaction = vi.fn(async () => transaction);
  const connection = { getParsedTokenAccountsByOwner, getSignaturesForAddress, getParsedTransaction } as unknown as Connection;
  vi.mocked(importVerifiedCompoundReceipt).mockResolvedValue(receipt);
  return { wallet: wallet.toBase58(), mint, sources, receipt, connection, transaction,
    getParsedTokenAccountsByOwner, getSignaturesForAddress, getParsedTransaction };
}

beforeEach(() => vi.clearAllMocks());

describe("historical compound cleanup discovery", () => {
  it("scans both token programs, excludes ATAs and deduplicates proven pairs including zero balances", async () => {
    const f = fixture();
    const result = await discoverCompoundCleanup(f.connection, f.wallet);
    expect(result).toMatchObject({ wallet: f.wallet, receipts: [f.receipt], scanned: 2, totalCandidates: 2,
      nextCursor: null, incomplete: false, errors: 0 });
    expect(f.getParsedTokenAccountsByOwner).toHaveBeenCalledTimes(2);
    expect(f.getSignaturesForAddress).toHaveBeenCalledTimes(1);
    expect(importVerifiedCompoundReceipt).toHaveBeenCalledWith(expect.anything(), f.transaction, f.wallet, signature());
    expect(f.getParsedTransaction).toHaveBeenCalledWith(signature(), { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  });
  it("retains the remaining leg after the other source has already closed", async () => {
    const f = fixture(1);
    f.receipt.compoundAccounts = [...f.sources, { ...f.sources[0]!, address: key().toBase58() }] as CompoundReceipt["compoundAccounts"];
    expect((await discoverCompoundCleanup(f.connection, f.wallet)).receipts).toEqual([f.receipt]);
  });
  it("does not emit an account merely because it is wallet-owned and non-ATA", async () => {
    const f = fixture();
    f.transaction.transaction.message.instructions = [];
    expect((await discoverCompoundCleanup(f.connection, f.wallet)).receipts).toEqual([]);
    expect(importVerifiedCompoundReceipt).not.toHaveBeenCalled();
  });
  it.each(["wallet", "source", "mint", "program", "signature"])("rejects mismatched %s proof", async field => {
    const f = fixture(1);
    if (field === "wallet") f.receipt.wallet = key().toBase58();
    if (field === "signature") f.receipt.sourceSignature = signature(2);
    if (field === "source") f.receipt.compoundAccounts[0].address = key().toBase58();
    if (field === "mint") f.receipt.compoundAccounts[0].mint = key().toBase58();
    if (field === "program") f.receipt.compoundAccounts[0].program = TOKEN_2022_PROGRAM_ID.toBase58();
    const result = await discoverCompoundCleanup(f.connection, f.wallet);
    expect(result.receipts).toEqual([]);
    expect(result.incomplete).toBe(true);
    expect(result.nextCursor).not.toBeNull();
  });
  it("reports RPC or proof failures as incomplete and retains a retry cursor", async () => {
    const f = fixture();
    vi.mocked(importVerifiedCompoundReceipt).mockRejectedValue(new Error("RPC read failed"));
    const result = await discoverCompoundCleanup(f.connection, f.wallet);
    expect(result).toMatchObject({ incomplete: true, errors: 1, receipts: [] });
    expect(result.nextCursor).not.toBeNull();
  });
  it("reports missing finalized transaction data as incomplete", async () => {
    const f = fixture();
    f.getParsedTransaction.mockResolvedValue(null as unknown as ParsedTransactionWithMeta);
    expect(await discoverCompoundCleanup(f.connection, f.wallet)).toMatchObject({ incomplete: true, errors: 1 });
  });
  it("paginates candidate accounts without skipping the next account", async () => {
    const f = fixture(CLEANUP_SCAN_ACCOUNTS + 1);
    f.transaction.transaction.message.instructions = [];
    const first = await discoverCompoundCleanup(f.connection, f.wallet);
    expect(first.scanned).toBe(CLEANUP_SCAN_ACCOUNTS);
    expect(first.nextCursor).not.toBeNull();
    const second = await discoverCompoundCleanup(f.connection, f.wallet, first.nextCursor);
    expect(second).toMatchObject({ scanned: 1, nextCursor: null, incomplete: false });
    expect(f.getSignaturesForAddress).toHaveBeenCalledTimes(CLEANUP_SCAN_ACCOUNTS + 1);
  });
  it("continues older candidate history after a full page instead of declaring it clean", async () => {
    const f = fixture(1);
    f.transaction.transaction.message.instructions = [];
    f.getSignaturesForAddress.mockResolvedValue(Array.from({ length: CLEANUP_SCAN_HISTORY }, () =>
      ({ signature: signature(), err: null, slot: 1, memo: null, blockTime: 1, confirmationStatus: "finalized" })));
    const first = await discoverCompoundCleanup(f.connection, f.wallet);
    expect(first).toMatchObject({ incomplete: false, receipts: [] });
    expect(first.nextCursor).not.toBeNull();
    f.getSignaturesForAddress.mockResolvedValue([]);
    const second = await discoverCompoundCleanup(f.connection, f.wallet, first.nextCursor);
    expect(f.getSignaturesForAddress.mock.calls.at(-1)?.[1]).toMatchObject({ before: signature() });
    expect(second.nextCursor).toBeNull();
  });
  it("caps recursive history proof work for the whole scan page", async () => {
    const f = fixture(1);
    vi.mocked(importVerifiedCompoundReceipt).mockImplementation(async connection => {
      for (let i = 0; i < 60; i++) await connection.getParsedTransaction(signature());
      return f.receipt;
    });
    expect(await discoverCompoundCleanup(f.connection, f.wallet)).toMatchObject({ incomplete: true, errors: 1, receipts: [] });
    expect(f.getParsedTransaction.mock.calls.length).toBeLessThanOrEqual(48);
  });
  it("rejects malformed cursors and stops an aborted scan", async () => {
    const f = fixture();
    await expect(discoverCompoundCleanup(f.connection, f.wallet, "bad-cursor")).rejects.toThrow("cursor");
    await expect(discoverCompoundCleanup(f.connection, f.wallet, undefined, AbortSignal.abort())).rejects.toThrow();
    expect(f.getParsedTokenAccountsByOwner).not.toHaveBeenCalled();
  });
});
