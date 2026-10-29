import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ simulate: vi.fn(), height: vi.fn(), send: vi.fn(), status: vi.fn() }));
vi.mock("@sofinance/engine/withdraw/build", () => ({ simulateWithdraw: mocks.simulate }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({ getBlockHeight: mocks.height, sendRawTransaction: mocks.send, getSignatureStatuses: mocks.status }) }));
import { submitWithdraw } from "./send";
import { withdrawPermit } from "@sofinance/engine/withdraw/permit";
import type { WithdrawSummary } from "@sofinance/engine/withdraw/types";
import {
  BLOCKHASH, LIGHTHOUSE_PROGRAM_ID, SIGNING_SECRET, appendWalletExtraInstruction, buildTransaction,
  messageBase64, phantomRewriteTransaction, signatureOf, testKeypair, toBase64,
} from "../test-support/send-fixtures";
import { TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
const payer = testKeypair(1), wallet = payer.publicKey.toBase58();
const transaction = buildTransaction({ payer });
function input(overrides: Partial<WithdrawSummary> = {}) {
    const summary = { operation: "withdraw", wallet, stage: "atomic", expiresAt: Date.now() + 60000, lastValidBlockHeight: 150, blockhash: BLOCKHASH, requiresSecondConfirmation: false, ...overrides } as WithdrawSummary;
    return { wallet, signedTransaction: toBase64(transaction), summary, permit: withdrawPermit.issue(SIGNING_SECRET, { wallet, message: messageBase64(transaction), summary }) };
}
beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
    mocks.height.mockResolvedValue(100);
    mocks.simulate.mockResolvedValue({});
    mocks.send.mockResolvedValue(signatureOf(transaction));
    mocks.status.mockResolvedValue({ value: [{ confirmationStatus: "confirmed" }] });
});
it("re-simulates the signed exact message before the single RPC submission", async () => {
    const body = input();
    expect(await submitWithdraw(body)).toEqual({ signature: signatureOf(transaction) });
    expect(mocks.simulate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ operation: "withdraw" }), true, undefined);
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.simulate.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]!);
});
it("rejects a forged permit or a changed summary before simulation or sending", async () => {
    const body = input();
    body.summary.requiresSecondConfirmation = true;
    await expect(submitWithdraw(body)).rejects.toThrow("authorization");
    expect(mocks.simulate).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
});
it("requires the high-impact second confirmation even with a valid permit", async () => {
    const body = input({ requiresSecondConfirmation: true });
    await expect(submitWithdraw(body)).rejects.toThrow("Confirm");
    expect(mocks.send).not.toHaveBeenCalled();
    await expect(submitWithdraw({ ...body, confirmHighImpact: true })).resolves.toHaveProperty("signature");
});
it("rejects expired authorizations and blockhashes", async () => {
    await expect(submitWithdraw(input({ expiresAt: Date.now() - 1 }))).rejects.toThrow("expired");
    mocks.height.mockResolvedValue(151);
    await expect(submitWithdraw(input())).rejects.toThrow("blockhash expired");
    expect(mocks.send).not.toHaveBeenCalled();
});
it("rejects unsigned transactions and invalid wallet signatures", async () => {
    const body = input();
    const unsigned = buildTransaction({ payer, signWith: [] });
    await expect(submitWithdraw({ ...body, signedTransaction: toBase64(unsigned) })).rejects.toThrow("Invalid");
    const invalid = buildTransaction({ payer });
    invalid.signatures[0]![0] = invalid.signatures[0]![0]! ^ 1;
    await expect(submitWithdraw({ ...body, signedTransaction: toBase64(invalid) })).rejects.toThrow("signature");
    expect(mocks.send).not.toHaveBeenCalled();
});
it("rebroadcasts the same signed bytes until the signature is observed", async () => {
    mocks.status.mockResolvedValueOnce({ value: [null] }).mockResolvedValueOnce({ value: [{ confirmationStatus: "processed" }] });
    expect(await submitWithdraw(input())).toHaveProperty("signature", signatureOf(transaction));
    expect(mocks.send).toHaveBeenCalledTimes(2);
});
it("never sends when signed simulation fails", async () => {
    mocks.simulate.mockRejectedValue(new Error("Wallet token balance changed"));
    await expect(submitWithdraw(input())).rejects.toThrow("balance changed");
    expect(mocks.send).not.toHaveBeenCalled();
});
it("accepts a Phantom-style recompile (replaced ComputeBudget + inserted Lighthouse)", async () => {
    const unsigned = buildTransaction({ payer, signWith: [] });
    const rewritten = phantomRewriteTransaction(unsigned);
    rewritten.sign([payer]);
    mocks.send.mockResolvedValue(signatureOf(rewritten));
    const summary = { operation: "withdraw", wallet, stage: "atomic", expiresAt: Date.now() + 60000, lastValidBlockHeight: 150, blockhash: rewritten.message.recentBlockhash, requiresSecondConfirmation: false } as WithdrawSummary;
    expect(await submitWithdraw({
        wallet, signedTransaction: toBase64(rewritten), unsignedTransaction: toBase64(unsigned), summary,
        permit: withdrawPermit.issue(SIGNING_SECRET, { wallet, message: messageBase64(unsigned), summary }),
    })).toHaveProperty("signature", signatureOf(rewritten));
    expect(mocks.simulate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), true, expect.any(VersionedTransaction));
    expect(mocks.send).toHaveBeenCalledOnce();
});
it("accepts a wallet-appended Lighthouse instruction when unsignedTransaction is provided", async () => {
    const unsigned = buildTransaction({ payer, signWith: [] });
    const extra = appendWalletExtraInstruction(unsigned);
    extra.sign([payer]);
    mocks.send.mockResolvedValue(signatureOf(extra));
    const summary = { operation: "withdraw", wallet, stage: "atomic", expiresAt: Date.now() + 60000, lastValidBlockHeight: 150, blockhash: extra.message.recentBlockhash, requiresSecondConfirmation: false } as WithdrawSummary;
    expect(await submitWithdraw({
        wallet, signedTransaction: toBase64(extra), unsignedTransaction: toBase64(unsigned), summary,
        permit: withdrawPermit.issue(SIGNING_SECRET, { wallet, message: messageBase64(unsigned), summary }),
    })).toHaveProperty("signature", signatureOf(extra));
    expect(mocks.send).toHaveBeenCalledOnce();
});
it("rejects a wallet-returned tx that drops a core instruction", async () => {
    const unsigned = buildTransaction({ payer, signWith: [] });
    const emptied = new VersionedTransaction(new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: unsigned.message.recentBlockhash,
        instructions: [new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([1]) })],
    }).compileToV0Message());
    emptied.sign([payer]);
    const summary = { operation: "withdraw", wallet, stage: "atomic", expiresAt: Date.now() + 60000, lastValidBlockHeight: 150, blockhash: unsigned.message.recentBlockhash, requiresSecondConfirmation: false } as WithdrawSummary;
    await expect(submitWithdraw({
        wallet, signedTransaction: toBase64(emptied), unsignedTransaction: toBase64(unsigned), summary,
        permit: withdrawPermit.issue(SIGNING_SECRET, { wallet, message: messageBase64(unsigned), summary }),
    })).rejects.toThrow("required instruction");
    expect(mocks.send).not.toHaveBeenCalled();
});
