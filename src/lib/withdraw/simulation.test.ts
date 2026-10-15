import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { simulateWithdraw } from "@sofinance/engine/withdraw/build";
import type { WithdrawSummary } from "@sofinance/engine/withdraw/types";
import { BLOCKHASH, testKeypair } from "../test-support/send-fixtures";
const wallet = testKeypair(1).publicKey, mint = testKeypair(2).publicKey, position = testKeypair(3).publicKey, positionMint = testKeypair(4).publicKey;
const account = getAssociatedTokenAddressSync(mint, wallet);
function token(amount: bigint) { const data = Buffer.alloc(165); mint.toBuffer().copy(data); wallet.toBuffer().copy(data, 32); data.writeBigUInt64LE(amount, 64); data[108] = 1; return { data, owner: TOKEN_PROGRAM_ID, lamports: 2039280, executable: false, rentEpoch: 0 }; }
function fixture(stage: "atomic" | "withdraw" | "swap" = "withdraw") {
    let initial = token(100n), ending = token(150n);
    const native = { data: Buffer.alloc(0), owner: SystemProgram.programId, lamports: 100000000, executable: false, rentEpoch: 0 };
    const summary = { wallet: wallet.toBase58(), positionAccount: position.toBase58(), positionMint: positionMint.toBase58(), stage, closesPosition: true, receive: "original", maxSolDebitLamports: "5000", assets: [{ mint: mint.toBase58(), account: account.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, starting: "100", amount: "50" }], outputs: [{ mint: mint.toBase58(), expected: "50", minimum: "50", decimals: 6 }] } as WithdrawSummary;
    const connection = { getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[]) => ({ context: { slot: 10 }, value: keys.map(k => k.equals(wallet) ? native : k.equals(account) ? initial : null) })), simulateTransaction: vi.fn(async (_transaction, config: {
            accounts: {
                addresses: string[];
            };
        }) => ({ value: { err: null, accounts: config.accounts.addresses.map(k => { const value = k === wallet.toBase58() ? native : k === account.toBase58() ? ending : null; return value ? { ...value, owner: value.owner.toBase58(), data: [value.data.toString("base64"), "base64"] } : null; }) } })) } as unknown as Connection;
    const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: BLOCKHASH, instructions: [] }).compileToV0Message());
    return { summary, connection, transaction, setInitial: (amount: bigint) => { initial = token(amount); }, setEnding: (amount: bigint) => { ending = token(amount); } };
}
it("verifies withdrawal minimums and fails closed if received amounts shrink", async () => {
    const f = fixture();
    await expect(simulateWithdraw(f.connection, f.transaction, f.summary)).resolves.toBeDefined();
    f.setEnding(149n);
    await expect(simulateWithdraw(f.connection, f.transaction, f.summary)).rejects.toThrow("below simulated minimum");
});
it("rejects changes to starting wallet inventory", async () => {
    const f = fixture();
    f.setInitial(101n);
    await expect(simulateWithdraw(f.connection, f.transaction, f.summary)).rejects.toThrow("balance changed");
});
it("preserves all prior wallet tokens during atomic conversion", async () => {
    const f = fixture("atomic");
    f.summary.outputs = [];
    f.setEnding(99n);
    await expect(simulateWithdraw(f.connection, f.transaction, f.summary)).rejects.toThrow("existing wallet inventory");
});
it("caps conversion-stage debits at the received amount", async () => {
    const f = fixture("swap");
    f.summary.outputs = [];
    f.setEnding(50n);
    await expect(simulateWithdraw(f.connection, f.transaction, f.summary)).resolves.toBeDefined();
    f.setEnding(49n);
    await expect(simulateWithdraw(f.connection, f.transaction, f.summary)).rejects.toThrow("existing wallet inventory");
});
it("rejects pre-funded isolated atomic sources", async () => {
    const f = fixture("atomic");
    f.summary.outputs = [];
    f.summary.isolatedSources = [{ address: account.toBase58(), mint: mint.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), seed: "seed", space: 165, rentLamports: 2039280 }];
    await expect(simulateWithdraw(f.connection, f.transaction, f.summary)).rejects.toThrow("already exists");
});
it("allows the full-withdrawal close to touch the position NFT account", async () => {
    const f = fixture();
    await simulateWithdraw(f.connection, f.transaction, f.summary);
    const addresses = (vi.mocked(f.connection.simulateTransaction).mock.calls[0]?.[1] as unknown as { accounts: { addresses: string[] } }).accounts.addresses;
    expect(addresses).toContain(getAssociatedTokenAddressSync(positionMint, wallet, false, TOKEN_2022_PROGRAM_ID).toBase58());
});
