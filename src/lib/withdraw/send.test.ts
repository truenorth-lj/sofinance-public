import { beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ simulate: vi.fn(), height: vi.fn(), send: vi.fn(), beam: vi.fn() }));
vi.mock("./build", () => ({ simulateWithdraw: mocks.simulate }));
vi.mock("../rpc", () => ({ rpcConnection: () => ({ getBlockHeight: mocks.height, sendRawTransaction: mocks.send }) }));
vi.mock("../solami-beam", () => ({ lookupBeamAfterSend: mocks.beam }));
import { submitWithdraw } from "./send";
import { withdrawPermit } from "./permit";
import type { WithdrawSummary } from "./types";
import { BLOCKHASH, SIGNING_SECRET, buildTransaction, messageBase64, signatureOf, testKeypair, toBase64 } from "../test-support/send-fixtures";
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
    mocks.beam.mockResolvedValue({ beam: null, label: null, beamLandingUrl: "url" });
});
it("re-simulates the signed exact message before the single RPC submission", async () => {
    expect(await submitWithdraw(input())).toHaveProperty("signature", signatureOf(transaction));
    expect(mocks.simulate).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ operation: "withdraw" }), true);
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
it("never sends when signed simulation fails", async () => {
    mocks.simulate.mockRejectedValue(new Error("Wallet token balance changed"));
    await expect(submitWithdraw(input())).rejects.toThrow("balance changed");
    expect(mocks.send).not.toHaveBeenCalled();
});
