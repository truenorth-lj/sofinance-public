import { beforeEach, expect, it, vi } from "vitest";
import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({}) }));
vi.mock("@sofinance/engine/config/server-env", () => ({ getSigningSecret: () => "batch-test-secret" }));
vi.mock("@/lib/compound-cleanup-batch", async original => ({ ...await original<typeof import("@/lib/compound-cleanup-batch")>(), buildCleanupBatch: mocks.build }));
vi.mock("@/lib/api-response", () => ({ apiError: () => Response.json({ error: "Prepare failed" }, { status: 400 }) }));
import { verifyCleanupBatchPermit } from "@/lib/compound-cleanup-batch";
import { POST } from "./route";
const wallet = Keypair.generate().publicKey;
const request = (body: unknown) => new Request("http://localhost/api/compound-cleanup-prepare", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => vi.resetAllMocks());
it("returns independently authorized messages for every size-bounded transaction", async () => {
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] }).compileToV0Message());
  const summary = { operation: "recovery", wallet: wallet.toBase58(), marker: "all sources and budgets" };
  mocks.build.mockResolvedValue({ alreadyClosed: ["previously-closed-source"], transactions: [{ transaction, summary }] });
  const response = await POST(request({ wallet: wallet.toBase58(), compoundAccounts: [] }));
  const body = await response.json();
  expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(body).toMatchObject({ wallet: wallet.toBase58(), alreadyClosed: ["previously-closed-source"] });
  const prepared = body.transactions[0];
  expect(verifyCleanupBatchPermit("batch-test-secret", { wallet: wallet.toBase58(), summary,
    message: Buffer.from(transaction.message.serialize()).toString("base64") }, prepared.permit)).toBe(true);
  expect(VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransaction, "base64")).signatures[0]!.every(byte => byte === 0)).toBe(true);
});
it("returns already-closed sources without manufacturing another wallet approval", async () => {
  mocks.build.mockResolvedValue({ alreadyClosed: ["closed"], transactions: [] });
  expect(await (await POST(request({ wallet: wallet.toBase58(), compoundAccounts: [] }))).json()).toEqual({ wallet: wallet.toBase58(), alreadyClosed: ["closed"], transactions: [] });
});
it("rejects invalid wallets and overlarge bodies before builder work", async () => {
  expect((await POST(request({ wallet: "invalid" }))).status).toBe(400);
  expect((await POST(request({ wallet: wallet.toBase58(), excess: "a".repeat(30000) }))).status).toBe(400);
  expect(mocks.build).not.toHaveBeenCalled();
});
it("does not turn simulation or RPC errors into an already-cleaned result", async () => {
  mocks.build.mockRejectedValue(new Error("Fetch is aborted"));
  expect((await POST(request({ wallet: wallet.toBase58(), compoundAccounts: [] }))).status).toBe(400);
});
