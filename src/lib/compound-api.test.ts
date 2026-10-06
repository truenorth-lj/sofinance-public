import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
import { parseCompoundBroadcast } from "./compound-api";
import { issueCompoundPermit } from "./compound-permit";

afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv("JUPITER_API_KEY", "test-only-secret");
  const owner = Keypair.generate(), receiver = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: receiver, lamports: 1 })] }).compileToV0Message());
  transaction.sign([owner]);
  const wallet = owner.publicKey.toBase58();
  const summary = { operation: "recovery", wallet, expiresAt: Date.now() + 30_000, lastValidBlockHeight: 100, blockhash };
  const permit = issueCompoundPermit("test-only-secret", { wallet, summary,
    message: Buffer.from(transaction.message.serialize()).toString("base64") });
  const body = { wallet, summary, permit, signedTransaction: Buffer.from(transaction.serialize()).toString("base64") };
  const request = (value = body) => new Request("http://localhost/api/compound-recover-broadcast", { method: "POST", body: JSON.stringify(value) });
  return { body, request, transaction };
}
describe("broadcast's trusted server boundary", () => {
  it("rejects metadata substitution, operation replay and a different signed message", async () => {
    const { body, request, transaction } = fixture();
    await expect(parseCompoundBroadcast(request(), "recovery")).resolves.toMatchObject({ wallet: body.wallet });
    await expect(parseCompoundBroadcast(request(), "compound")).rejects.toThrow(/authorization type/i);
    await expect(parseCompoundBroadcast(request({ ...body, summary: { ...body.summary, lastValidBlockHeight: 101 } }), "recovery")).rejects.toThrow(/does not match/i);
    transaction.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    await expect(parseCompoundBroadcast(request({ ...body, signedTransaction: Buffer.from(transaction.serialize()).toString("base64") }), "recovery")).rejects.toThrow(/does not match/i);
  });
  it("rejects expired permits even when their HMAC is correct", async () => {
    const { body, request, transaction } = fixture();
    const summary = { ...body.summary, expiresAt: Date.now() - 1 };
    const permit = issueCompoundPermit("test-only-secret", { wallet: body.wallet, summary,
      message: Buffer.from(transaction.message.serialize()).toString("base64") });
    await expect(parseCompoundBroadcast(request({ ...body, summary, permit }), "recovery")).rejects.toThrow("expiry");
  });
});
