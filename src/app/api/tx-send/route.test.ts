// POST /api/tx-send: the pipeline's one-shot relay. Permit-bound, rate limited, no resend loop, no expiry gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/config/server-env", async (original) => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(), getSigningSecret: () => "test-signing-secret-not-a-real-key",
}));

import { rpcConnection } from "@sofinance/engine/rpc";
import {
  buildTransaction, fakeConnection, oversizedSignedBase64, phantomRewriteTransaction, SIGNING_SECRET, signatureOf,
  tamperTransferLamports, testKeypair, toBase64, type FakeConnection,
} from "@/lib/test-support/send-fixtures";
import { sendPermitFor } from "@/lib/tx-send/permit";
const permitOf = (tx: VersionedTransaction) => sendPermitFor(tx.message.staticAccountKeys[0]!.toBase58(), Buffer.from(tx.serialize()).toString("base64"), SIGNING_SECRET);
import { resetTxSendRateLimit, TX_SEND_REQUESTS_PER_IP_PER_MINUTE } from "@/lib/tx-send/rate-limit";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { POST } from "./route";

const payer = testKeypair(21);
const mint = testKeypair(22);
const unsignedOf = (options: { extraSigners?: typeof mint[] } = {}) => buildTransaction({ payer, ...options, signWith: [] });
/** Body the pipeline relay sends: wallet-signed bytes plus the prepared message and its permit. */
function relayBody(prepared: VersionedTransaction, signed: VersionedTransaction, permit = permitOf(prepared)) {
  return { signedTransaction: toBase64(signed), unsignedTransaction: toBase64(prepared), sendPermit: permit };
}
function signedBody(options: { extraSigners?: typeof mint[] } = {}) {
  const prepared = unsignedOf(options);
  const signed = buildTransaction({ payer, ...options });
  return { prepared, signed, body: relayBody(prepared, signed) };
}
async function call(body: unknown, ip = "203.0.113.7") {
  const request = new Request("http://localhost/api/tx-send", {
    method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body),
  });
  const response = await POST(request);
  return { status: response.status, json: await response.json() as Record<string, unknown>, headers: response.headers };
}
let connection: FakeConnection;
beforeEach(() => {
  resetTxSendRateLimit();
  vi.spyOn(console, "error").mockImplementation(() => {});
  connection = fakeConnection();
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("POST /api/tx-send", () => {
  it("sends fully signed, permitted bytes once with preflight and RPC rebroadcast (maxRetries 3)", async () => {
    const { signed, body } = signedBody({ extraSigners: [mint] });
    connection.sendRawTransaction.mockResolvedValue(signatureOf(signed));
    const { status, json } = await call(body);
    expect(status).toBe(200); expect(json).toEqual({ signature: signatureOf(signed) });
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction.mock.calls[0]![1]).toMatchObject({ skipPreflight: false, maxRetries: 3 });
    expect(connection.getBlockHeight).not.toHaveBeenCalled();
  });
  it("accepts a Phantom-style rewrite (ComputeBudget + Lighthouse) of a permitted message", async () => {
    const prepared = unsignedOf();
    const signed = phantomRewriteTransaction(buildTransaction({ payer })); signed.sign([payer]);
    connection.sendRawTransaction.mockResolvedValue(signatureOf(signed));
    const { status } = await call(relayBody(prepared, signed));
    expect(status).toBe(200);
  });
  it("is not an open relay: refuses an arbitrary signed transaction without a permit", async () => {
    const { status, json } = await call({ signedTransaction: toBase64(buildTransaction({ payer })) });
    expect(status).toBe(400); expect(json.sent).toBe(false);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("refuses a forged permit and a permit issued for a different message", async () => {
    const { prepared, signed } = signedBody();
    expect((await call(relayBody(prepared, signed, "a".repeat(64)))).json.sent).toBe(false);
    const other = buildTransaction({ payer, blockhash: bs58.encode(new Uint8Array(32).fill(3)), signWith: [] });
    expect((await call(relayBody(prepared, signed, permitOf(other)))).json.sent).toBe(false);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("refuses signed bytes that change a prepared instruction (permit is for the prepared message only)", async () => {
    const prepared = unsignedOf();
    const tampered = tamperTransferLamports(buildTransaction({ payer }), 999_999); tampered.sign([payer]);
    const { status, json } = await call(relayBody(prepared, tampered));
    expect(status).toBe(400); expect(json.sent).toBe(false);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it.each([
    ["missing body", {}],
    ["not base64 tx", { signedTransaction: "AAAA" }],
    ["unsigned", relayBody(unsignedOf(), unsignedOf())],
    ["missing cosigner", relayBody(unsignedOf({ extraSigners: [mint] }), buildTransaction({ payer, extraSigners: [mint], signWith: [payer] }))],
    ["oversized", { signedTransaction: oversizedSignedBase64(payer), unsignedTransaction: toBase64(unsignedOf()), sendPermit: permitOf(unsignedOf()) }],
  ])("refuses %s as not sent without touching RPC", async (_name, body) => {
    const { status, json } = await call(body);
    expect(status).toBe(400); expect(json.sent).toBe(false);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("refuses a forged signature", async () => {
    const { prepared, signed } = signedBody();
    signed.signatures[0] = new Uint8Array(64).fill(5);
    const { json } = await call(relayBody(prepared, signed));
    expect(json.sent).toBe(false); expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("rate limits per IP with 429 and Retry-After, without touching RPC", async () => {
    for (let index = 0; index < TX_SEND_REQUESTS_PER_IP_PER_MINUTE; index++) await call({}, "198.51.100.1");
    const limited = await call(signedBody().body, "198.51.100.1");
    expect(limited.status).toBe(429); expect(limited.json.sent).toBe(false); expect(limited.headers.get("Retry-After")).toBe("60");
    expect((await call({}, "198.51.100.2")).status).toBe(400);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("marks a preflight refusal as not sent (plain 4xx)", async () => {
    connection.sendRawTransaction.mockRejectedValue(new Error("Transaction simulation failed: Blockhash not found"));
    const { status, json } = await call(signedBody().body);
    expect(status).toBe(400); expect(json.sent).toBe(false);
  });
  it("does not claim not-sent for an RPC failure that may have reached the network", async () => {
    connection.sendRawTransaction.mockRejectedValue(new Error("socket hang up"));
    const { status, json } = await call(signedBody().body);
    expect(status).toBe(502); expect(json.sent).toBeUndefined();
  });
  it("does not trust an RPC that returns a different signature", async () => {
    connection.sendRawTransaction.mockResolvedValue(bs58.encode(new Uint8Array(64).fill(8)));
    const { status, json } = await call(signedBody().body);
    expect(status).toBe(502); expect(json.sent).toBeUndefined();
  });
});

describe("POST /api/tx-send strict comparison", () => {
  const BLOCKHASH = buildTransaction({ payer, signWith: [] }).message.recentBlockhash;
  const program = testKeypair(33).publicKey;
  const table = testKeypair(30).publicKey;
  const [inTable, alsoInTable, outside] = [testKeypair(31).publicKey, testKeypair(32).publicKey, testKeypair(34).publicKey];
  const lookupTable = new AddressLookupTableAccount({ key: table, state: {
    deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [inTable, alsoInTable],
  } });
  const transfer = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: testKeypair(200).publicKey, lamports: 1 });
  const usesAccount = (account: PublicKey) => new TransactionInstruction({ programId: program, keys: [{ pubkey: account, isSigner: false, isWritable: false }], data: Buffer.from([7]) });
  const compile = (instructions: TransactionInstruction[], tables: AddressLookupTableAccount[] = []) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: BLOCKHASH, instructions }).compileToV0Message(tables));
  const signedCopy = (tx: VersionedTransaction) => { const copy = VersionedTransaction.deserialize(tx.serialize()); copy.sign([payer]); return copy; };
  let lookups: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    lookups = vi.fn(async (key: PublicKey) => ({ value: key.equals(table) ? lookupTable : null }));
    Object.assign(connection, { getAddressLookupTable: lookups });
    connection.sendRawTransaction.mockImplementation(async (bytes: unknown) => signatureOf(VersionedTransaction.deserialize(bytes as Uint8Array)));
  });

  it("refuses an inserted SystemProgram.transfer (extra instructions only from ComputeBudget, Lighthouse or Memo)", async () => {
    const prepared = compile([transfer]);
    const drained = signedCopy(compile([transfer, SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: outside, lamports: 1_000_000_000 })]));
    const { status, json } = await call(relayBody(prepared, drained));
    expect(status).toBe(400); expect(json.sent).toBe(false);
    expect(String(json.error)).toMatch(/added or changed an instruction/);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("refuses an inserted transfer placed before the prepared instructions too", async () => {
    const prepared = compile([transfer]);
    const drained = signedCopy(compile([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: outside, lamports: 5 }), transfer]));
    expect((await call(relayBody(prepared, drained))).status).toBe(400);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("accepts wallet-added ComputeBudget and Memo instructions", async () => {
    const prepared = compile([transfer]);
    const memo = new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("wallet") });
    const signed = signedCopy(compile([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), transfer, memo]));
    expect((await call(relayBody(prepared, signed))).status).toBe(200);
  });
  it("compares lookup-table accounts slot-for-slot when the table lookups are unchanged (no RPC lookup)", async () => {
    const prepared = compile([transfer, usesAccount(inTable)], [lookupTable]);
    expect(prepared.message.addressTableLookups).toHaveLength(1);
    const signed = signedCopy(prepared);
    expect((await call(relayBody(prepared, signed))).status).toBe(200);
    expect(lookups).not.toHaveBeenCalled();
  });
  it("resolves lookup tables when the wallet rewrites them and accepts the same addresses", async () => {
    const prepared = compile([transfer, usesAccount(inTable)], [lookupTable]);
    const signed = signedCopy(compile([transfer, usesAccount(inTable)]));
    expect((await call(relayBody(prepared, signed))).status).toBe(200);
    expect(lookups).toHaveBeenCalledWith(table);
  });
  it("refuses a lookup-table account swapped for another address", async () => {
    const prepared = compile([transfer, usesAccount(inTable)], [lookupTable]);
    const signed = signedCopy(compile([transfer, usesAccount(alsoInTable)]));
    const { status, json } = await call(relayBody(prepared, signed));
    expect(status).toBe(400); expect(json.sent).toBe(false);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("refuses (never skips) a lookup table that cannot be resolved", async () => {
    lookups.mockResolvedValue({ value: null });
    const prepared = compile([transfer, usesAccount(inTable)], [lookupTable]);
    const signed = signedCopy(compile([transfer, usesAccount(inTable)]));
    const { status, json } = await call(relayBody(prepared, signed));
    expect(status).toBe(400); expect(json.sent).toBe(false);
    expect(String(json.error)).toMatch(/could not be resolved/);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});
