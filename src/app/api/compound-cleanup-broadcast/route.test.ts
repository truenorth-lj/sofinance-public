import { beforeEach, expect, it, vi } from "vitest";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createCloseAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ send: vi.fn(), height: vi.fn(), simulate: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({ getBlockHeight: mocks.height, sendRawTransaction: mocks.send }) }));
vi.mock("@sofinance/engine/config/server-env", () => ({ getSigningSecret: () => "batch-test-secret" }));
vi.mock("@/lib/compound-cleanup-batch", async original => ({ ...await original<typeof import("@/lib/compound-cleanup-batch")>(), simulateAndVerifyCleanupBatch: mocks.simulate }));
vi.mock("@/lib/api-response", () => ({ apiError: (_error: unknown, _message: string, _status: number, details?: object) =>
  Response.json({ error: "Broadcast failed", ...details }, { status: 400 }) }));
import { issueCleanupBatchPermit } from "@/lib/compound-cleanup-batch";
import { issueCompoundPermit } from "@/lib/compound-permit";
import { POST } from "./route";
async function fixture() {
  const signer = Keypair.generate(), wallet = signer.publicKey.toBase58(), seed = "broadcast_batch", mint = Keypair.generate().publicKey;
  const source = await PublicKey.createWithSeed(signer.publicKey, seed, TOKEN_PROGRAM_ID), blockhash = Keypair.generate().publicKey.toBase58();
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash,
    instructions: [createCloseAccountInstruction(source, signer.publicKey, signer.publicKey)] }).compileToV0Message());
  transaction.sign([signer]);
  const summary: CompoundRecoverySummary = { operation: "recovery", simulated: true, wallet, compoundAccounts: [{ seed, address: source.toBase58(),
    mint: mint.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), space: 165, rentLamports: 2039280, sourceLamports: 2039280,
    amount: "0", decimals: 6, destination: getAssociatedTokenAddressSync(mint, signer.publicKey).toBase58() }],
    blockhash, lastValidBlockHeight: 100, expiresAt: Date.now() + 30000, sizeBytes: transaction.serialize().length, feeLamports: 5000 };
  const input = { wallet, summary, message: Buffer.from(transaction.message.serialize()).toString("base64") };
  const body = { wallet, summary, permit: issueCleanupBatchPermit("batch-test-secret", input), signedTransaction: Buffer.from(transaction.serialize()).toString("base64") };
  const request = (overrides = {}) => new Request("http://localhost/api/compound-cleanup-broadcast", { method: "POST", body: JSON.stringify({ ...body, ...overrides }) });
  return { request, body, input, transaction };
}
beforeEach(() => { vi.resetAllMocks(); mocks.height.mockResolvedValue(99); mocks.simulate.mockResolvedValue({ unitsConsumed: 1 }); });
it("only sends fully signed permitted transactions after fresh revalidation", async () => {
  const f = await fixture(), signature = bs58.encode(f.transaction.signatures[0]!); mocks.send.mockResolvedValue(signature);
  expect(await (await POST(f.request())).json()).toEqual({ signature });
  expect(mocks.simulate).toHaveBeenCalledWith(expect.objectContaining({ sigVerify: true, summary: expect.objectContaining({ wallet: f.body.wallet }) }));
  expect(mocks.send).toHaveBeenCalledWith(expect.any(Uint8Array), { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
});
it.each(["summary", "permit domain", "signature", "wallet", "message", "expiry"])("rejects %s tampering without broadcasting", async kind => {
  const f = await fixture(); let overrides: object = {};
  if (kind === "summary") overrides = { summary: { ...f.body.summary, feeLamports: 1 } };
  if (kind === "permit domain") overrides = { permit: issueCompoundPermit("batch-test-secret", f.input) };
  if (kind === "wallet") overrides = { wallet: Keypair.generate().publicKey.toBase58() };
  if (kind === "expiry") { f.body.summary.expiresAt = Date.now() - 1; overrides = { summary: f.body.summary,
    permit: issueCleanupBatchPermit("batch-test-secret", { ...f.input, summary: f.body.summary }) }; }
  if (kind === "signature" || kind === "message") {
    if (kind === "signature") f.transaction.signatures[0]![0] = f.transaction.signatures[0]![0]! ^ 1;
    else f.transaction.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    overrides = { signedTransaction: Buffer.from(f.transaction.serialize()).toString("base64") };
  }
  const response = await POST(f.request(overrides)); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ sent: false });
  expect(mocks.send).not.toHaveBeenCalled();
});
it("rejects changed sources discovered after the user approval", async () => {
  const f = await fixture(); mocks.simulate.mockRejectedValue(new Error("Cleanup source balance changed"));
  expect(await (await POST(f.request())).json()).toMatchObject({ sent: false }); expect(mocks.send).not.toHaveBeenCalled();
});
it("rechecks expiry after simulation", async () => {
  const f = await fixture(); mocks.height.mockResolvedValueOnce(99).mockResolvedValueOnce(101);
  expect(await (await POST(f.request())).json()).toMatchObject({ sent: false }); expect(mocks.send).not.toHaveBeenCalled();
});
it.each(["Fetch is aborted", "429 Too Many Requests", "RPC timeout"])("preserves uncertain send result %s for on-chain verification", async error => {
  const f = await fixture(); mocks.send.mockRejectedValue(new Error(error));
  const result = await (await POST(f.request())).json(); expect(result.sent).toBeUndefined(); expect(mocks.send).toHaveBeenCalledOnce();
});
