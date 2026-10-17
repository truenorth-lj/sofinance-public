import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, createCloseAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type AccountInfo } from "@solana/web3.js";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
import { rpcConnection } from "@sofinance/engine/rpc";
import { issueCompoundPermit } from "@/lib/compound-permit";
import { BLOCKHASH, SIGNING_SECRET, jsonRequest, messageBase64, signatureOf, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

// This exercises the actual recovery verifier between signed permits and broadcast.
// No recovery logic is mocked, and every wallet/key is synthetic and unfunded.
const rent = 2_039_280;
const owner = testKeypair(101), mint = testKeypair(102).publicKey;
const wallet = owner.publicKey.toBase58();
const seed = "s".repeat(32);
function info(data: Buffer, lamports = rent): AccountInfo<Buffer> {
  return { data, owner: TOKEN_PROGRAM_ID, lamports, executable: false, rentEpoch: 0 };
}
function token(amount: bigint) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner: owner.publicKey, amount, delegateOption: 0, delegate: PublicKey.default,
    state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return info(data);
}
function mintInfo() {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000n, decimals: 6,
    isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  return info(data);
}
async function fixture(amount = 5n) {
  const source = await PublicKey.createWithSeed(owner.publicKey, seed, TOKEN_PROGRAM_ID);
  const destination = getAssociatedTokenAddressSync(mint, owner.publicKey);
  const sourceInfo = token(amount);
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: BLOCKHASH,
    instructions: [...(amount > 0n ? [createTransferCheckedInstruction(source, mint, destination, owner.publicKey, amount, 6)] : []),
      createCloseAccountInstruction(source, owner.publicKey, owner.publicKey)] }).compileToV0Message());
  transaction.sign([owner]);
  const summary = { operation: "recovery", simulated: true, wallet, compoundAccounts: [{ seed, address: source.toBase58(),
    mint: mint.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), space: 165, rentLamports: rent, sourceLamports: rent,
    amount: amount.toString(), decimals: 6, destination: destination.toBase58() }], feeLamports: 5000,
    sizeBytes: transaction.serialize().length, blockhash: BLOCKHASH, lastValidBlockHeight: 150, expiresAt: Date.now() + 60_000 };
  const readback = new Map<string, AccountInfo<Buffer> | null>([
    [source.toBase58(), null], [destination.toBase58(), token(100n + amount)],
    [wallet, { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 100_000_000 + rent - 5000, executable: false, rentEpoch: 0 }],
  ]);
  const connection = {
    getBlockHeight: vi.fn(async () => 100), getBalance: vi.fn(async () => 100_000_000),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map(key => key.equals(source) ? sourceInfo : key.equals(mint) ? mintInfo() : key.equals(destination) ? token(100n) : null)),
    simulateTransaction: vi.fn(async (_tx: VersionedTransaction, config: { accounts: { addresses: string[] } }) => ({ value: { err: null,
      accounts: config.accounts.addresses.map(address => { const account = readback.get(address); return account ? {
        ...account, owner: account.owner.toBase58(), data: [account.data.toString("base64"), "base64"],
      } : null; }) } })),
    sendRawTransaction: vi.fn(async () => signatureOf(transaction)),
  };
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
  const body = { wallet, summary, signedTransaction: toBase64(transaction), permit: issueCompoundPermit(SIGNING_SECRET,
    { wallet, summary, message: messageBase64(transaction) }) };
  const call = async () => { const response = await POST(jsonRequest("http://localhost/api/compound-recover-broadcast", body)); return { response, json: await response.json() }; };
  return { source, destination, sourceInfo, transaction, summary, connection, readback, call };
}
beforeEach(() => { vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("recovery broadcast safety with the real balance verifier", () => {
  it("merges exact dust into an existing ATA while preserving its 100-unit inventory", async () => {
    const f = await fixture();
    expect((await f.call()).response.status).toBe(200);
    expect(f.connection.simulateTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sigVerify: true }));
    expect(f.connection.sendRawTransaction).toHaveBeenCalledOnce();
  });
  it("closes an empty historical source without needing a destination ATA", async () => {
    const f = await fixture(0n);
    f.readback.delete(f.destination.toBase58());
    expect((await f.call()).response.status).toBe(200);
    expect(f.connection.simulateTransaction.mock.calls[0]![1].accounts.addresses).toEqual([f.source.toBase58(), wallet]);
  });
  it.each(["amount", "rent"])("rejects a source whose %s changed after preparation before any broadcast", async field => {
    const f = await fixture();
    if (field === "amount") f.sourceInfo.data.writeBigUInt64LE(6n, 64);
    else f.sourceInfo.lamports++;
    expect((await f.call()).json).toMatchObject({ sent: false, error: expect.stringMatching(/balance or identity has changed/) });
    expect(f.connection.simulateTransaction).not.toHaveBeenCalled();
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it.each([104n, 106n, 99n])("rejects a wrong ATA result of %s units without broadcasting", async received => {
    const f = await fixture();
    f.readback.set(f.destination.toBase58(), token(received));
    expect((await f.call()).json).toMatchObject({ sent: false, error: "Recovery amount or recipient mismatch" });
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("rejects a leftover source even when the destination receives the expected token amount", async () => {
    const f = await fixture();
    f.readback.set(f.source.toBase58(), token(0n));
    expect((await f.call()).json).toMatchObject({ sent: false, error: "Simulation did not close yield account" });
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("rechecks block height after verification and stops a recovery that expired during simulation", async () => {
    const f = await fixture();
    f.connection.getBlockHeight.mockResolvedValueOnce(100).mockResolvedValueOnce(151);
    expect((await f.call()).json).toMatchObject({ sent: false, error: "Recovery transaction expired before broadcast" });
    expect(f.connection.simulateTransaction).toHaveBeenCalledOnce();
    expect(f.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});
