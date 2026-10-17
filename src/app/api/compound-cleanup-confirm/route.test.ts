import { beforeEach, expect, it, vi } from "vitest";
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ statuses: vi.fn(), transaction: vi.fn(), height: vi.fn(), sources: vi.fn(), reset: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({ getSignatureStatuses: mocks.statuses,
  getParsedTransaction: mocks.transaction, getBlockHeight: mocks.height, getMultipleAccountsInfo: mocks.sources }) }));
vi.mock("@sofinance/engine/rpc/cache", () => ({ resetRpcCache: mocks.reset }));
vi.mock("@/lib/api-response", () => ({ apiError: () => Response.json({ error: "Verification failed" }, { status: 400 }) }));
import { POST } from "./route";

const wallet = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
const signature = "2".repeat(88);
async function fixture(amount = "0") {
  const seed = "batch_confirm", address = await PublicKey.createWithSeed(wallet, seed, TOKEN_PROGRAM_ID);
  const destination = getAssociatedTokenAddressSync(mint, wallet);
  const summary: CompoundRecoverySummary = { operation: "recovery", simulated: true, wallet: wallet.toBase58(),
    compoundAccounts: [{ seed, address: address.toBase58(), mint: mint.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(),
      space: 165, rentLamports: 2039280, sourceLamports: 2039280, amount, decimals: 6, destination: destination.toBase58() }],
    feeLamports: 5000, sizeBytes: 300, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100, expiresAt: Date.now() + 30000 };
  const close = { programId: TOKEN_PROGRAM_ID, program: "spl-token", parsed: { type: "closeAccount", info: {
    account: address.toBase58(), destination: wallet.toBase58(), owner: wallet.toBase58() } } };
  const transfer = { programId: TOKEN_PROGRAM_ID, program: "spl-token", parsed: { type: "transferChecked", info: {
    source: address.toBase58(), destination: destination.toBase58(), authority: wallet.toBase58(), tokenAmount: { amount } } } };
  const record = (index: number, value: string) => ({ accountIndex: index, mint: mint.toBase58(), owner: wallet.toBase58(),
    programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount: value, decimals: 6, uiAmount: Number(value) / 1e6 } });
  const transaction = { transaction: { signatures: [signature], message: { accountKeys: [wallet, address, destination].map((pubkey, index) => ({ pubkey, signer: index === 0, writable: true })),
    instructions: amount === "0" ? [close] : [transfer, close], recentBlockhash: summary.blockhash } },
    meta: { err: null, fee: 5000, preTokenBalances: [record(1, amount), ...(amount === "0" ? [] : [record(2, "5")])],
      postTokenBalances: amount === "0" ? [] : [record(2, (BigInt(amount) + 5n).toString())] }, slot: 1 } as unknown as ParsedTransactionWithMeta;
  const request = (overrides = {}) => new Request("http://localhost/api/compound-cleanup-confirm", { method: "POST",
    body: JSON.stringify({ wallet: wallet.toBase58(), summary, signature, ...overrides }) });
  return { summary, transaction, request };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.statuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: null }] });
  mocks.height.mockResolvedValue(101); mocks.sources.mockResolvedValue([{ lamports: 1 }]);
});
it.each(["0", "7"])("requires a finalized exact receipt to confirm batch amount %s", async amount => {
  const f = await fixture(amount); mocks.transaction.mockResolvedValue(f.transaction);
  const response = await POST(f.request());
  expect(await response.json()).toEqual({ signature, status: "success", chainStatus: "success" });
  expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(mocks.reset).toHaveBeenCalledOnce();
});
it.each(["exception", "null", "missing metadata"])("keeps retrying after known-finalized %s instead of reporting false failure", async kind => {
  const f = await fixture();
  if (kind === "exception") mocks.transaction.mockRejectedValue(new Error("Fetch is aborted"));
  else mocks.transaction.mockResolvedValue(kind === "null" ? null : { ...f.transaction, meta: null });
  expect(await (await POST(f.request())).json()).toEqual({ signature, status: "pending", chainStatus: "pending" });
  expect(mocks.sources).not.toHaveBeenCalled();
});
it("keeps retrying transient status lookup failures", async () => {
  const f = await fixture(); mocks.statuses.mockRejectedValue(new Error("Fetch is aborted"));
  expect(await (await POST(f.request())).json()).toMatchObject({ status: "pending", chainStatus: "pending" });
});
it("does not trust confirmed-but-unfinalized status", async () => {
  const f = await fixture(); mocks.statuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed", err: null }] });
  expect(await (await POST(f.request())).json()).toMatchObject({ status: "pending" });
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("returns actual finalized transaction errors as failed", async () => {
  const f = await fixture(); mocks.statuses.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: { InstructionError: [0, "custom"] } }] });
  expect(await (await POST(f.request())).json()).toMatchObject({ status: "failed", chainStatus: "failed" });
});
it("uses finalized history when signature indexing misses an old transaction", async () => {
  const f = await fixture(); mocks.statuses.mockResolvedValue({ value: [null] }); mocks.transaction.mockResolvedValue(f.transaction);
  expect(await (await POST(f.request())).json()).toMatchObject({ status: "success" });
});
it("does not infer success from disappeared accounts when receipt is unavailable", async () => {
  const f = await fixture(); mocks.statuses.mockResolvedValue({ value: [null] }); mocks.transaction.mockResolvedValue(null); mocks.sources.mockResolvedValue([null]);
  expect(await (await POST(f.request())).json()).toMatchObject({ status: "manual-review", chainStatus: "unknown" });
});
it("expires only a missing signature beyond finalized validity with all sources still present", async () => {
  const f = await fixture(); mocks.statuses.mockResolvedValue({ value: [null] }); mocks.transaction.mockResolvedValue(null);
  expect(await (await POST(f.request())).json()).toMatchObject({ status: "expired", chainStatus: "expired" });
  mocks.height.mockResolvedValue(100);
  expect(await (await POST(f.request())).json()).toMatchObject({ status: "pending", chainStatus: "pending" });
});
it.each(["wrong credit", "wrong source program", "wrong close recipient", "missing transfer"])("does not confirm receipt with %s", async kind => {
  const f = await fixture("7");
  if (kind === "wrong credit") f.transaction.meta!.postTokenBalances![0]!.uiTokenAmount.amount = "11";
  if (kind === "wrong source program") f.transaction.meta!.preTokenBalances![0]!.programId = Keypair.generate().publicKey.toBase58();
  if (kind === "wrong close recipient") {
    const ix = f.transaction.transaction.message.instructions.at(-1)!;
    if ("parsed" in ix) ix.parsed.info.destination = Keypair.generate().publicKey.toBase58();
  }
  if (kind === "missing transfer") f.transaction.transaction.message.instructions.shift();
  mocks.transaction.mockResolvedValue(f.transaction);
  expect(await (await POST(f.request())).json()).toMatchObject({ status: "manual-review", chainStatus: "success" });
});
it("rejects oversized summaries and foreign recipients before RPC reads", async () => {
  const f = await fixture();
  const wrong = structuredClone(f.summary); wrong.compoundAccounts[0]!.destination = Keypair.generate().publicKey.toBase58();
  expect((await POST(f.request({ summary: wrong }))).status).toBe(400);
  expect((await POST(f.request({ summary: { ...f.summary, compoundAccounts: Array(65).fill(f.summary.compoundAccounts[0]) } }))).status).toBe(400);
  expect(mocks.statuses).not.toHaveBeenCalled();
});
