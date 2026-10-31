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
import { sendWithWallet, type TxWallet } from "@/lib/tx-pipeline/wallet-send";
import { LIGHTHOUSE_PROGRAM_ID, phantomMainnetReturn } from "@/lib/test-support/send-fixtures";

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
    expect(String(json.error)).toMatch(/Wallet added an instruction/);
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

// Regression (prod, ecd34ab): Phantom's open was refused with "Wallet added or changed an instruction
// (program L2TExMF…S95)" because the shared Lighthouse id was wrong. Each flow's prepared shape goes
// through the real client check (sendWithWallet, relay path) and this route, with the instructions Phantom
// returns on mainnet: its ComputeBudget, then Lighthouse AssertAccountData + AssertSysvarClock.
describe("Phantom mainnet Lighthouse instructions on every flow", () => {
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const JUPITER = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const pool = testKeypair(40).publicKey, position = testKeypair(41).publicKey, userToken = testKeypair(42).publicKey;
  const attacker = testKeypair(43).publicKey;
  const ix = (programId: PublicKey, tag: number, keys: { pubkey: PublicKey; isSigner?: boolean; isWritable?: boolean }[]) =>
    new TransactionInstruction({ programId, data: Buffer.from([tag, 1, 2, 3, 4, 5, 6, 7, 8]),
      keys: keys.map((key) => ({ pubkey: key.pubkey, isSigner: key.isSigner ?? false, isWritable: key.isWritable ?? true })) });
  const me = { pubkey: payer.publicKey, isSigner: true };
  const flows = {
    "open (mint cosign)": [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ix(DLMM, 1, [me, { pubkey: mint.publicKey, isSigner: true }, { pubkey: pool }]),
      ix(DLMM, 2, [me, { pubkey: mint.publicKey, isWritable: false }, { pubkey: pool }, { pubkey: userToken }])],
    add: [ix(JUPITER, 3, [me, { pubkey: userToken }]), ix(DLMM, 2, [me, { pubkey: position }, { pubkey: pool }, { pubkey: userToken }])],
    compound: [ix(DLMM, 4, [me, { pubkey: position }, { pubkey: pool }]), ix(JUPITER, 3, [me, { pubkey: userToken }]),
      ix(DLMM, 2, [me, { pubkey: position }, { pubkey: pool }, { pubkey: userToken }])],
    "withdraw/exit": [ix(DLMM, 5, [me, { pubkey: position }, { pubkey: pool }]), ix(DLMM, 6, [me, { pubkey: position }]),
      ix(TOKEN, 9, [{ pubkey: userToken }, { pubkey: payer.publicKey }, me])],
  } as const;
  const prepare = (instructions: readonly TransactionInstruction[]) =>
    new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: buildTransaction({ payer, signWith: [] }).message.recentBlockhash,
      instructions: [...instructions] }).compileToV0Message());
  const needsMint = (tx: VersionedTransaction) => tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).some((key) => key.equals(mint.publicKey));
  /** Phantom without signAndSend for the test: sign-then-relay, so our client check and this route both run. */
  const phantom = (extra: TransactionInstruction[] = []): TxWallet => ({
    address: payer.publicKey.toBase58(),
    signTransaction: async (tx) => {
      let returned = phantomMainnetReturn(tx, userToken);
      if (extra.length) {
        const message = TransactionMessage.decompile(returned.message);
        returned = new VersionedTransaction(new TransactionMessage({ ...message, instructions: [...message.instructions, ...extra] }).compileToV0Message());
      }
      returned.sign([payer]);
      return returned;
    },
  });
  const relayThroughRoute = vi.fn(async (signed: VersionedTransaction, context: { prepared: VersionedTransaction; sendPermit?: string }) => {
    const { json } = await call(relayBody(context.prepared, signed, context.sendPermit));
    if (typeof json.signature !== "string") throw Object.assign(new Error(String(json.error)), { sent: json.sent });
    return json.signature;
  });
  const sendFlow = (prepared: VersionedTransaction, wallet: TxWallet) => sendWithWallet(wallet, prepared, {
    sendPermit: permitOf(prepared), sendRaw: relayThroughRoute,
    ...(needsMint(prepared) ? { cosign: (walletSigned: VersionedTransaction) => { walletSigned.sign([mint]); return walletSigned; } } : {}),
  });
  beforeEach(() => {
    relayThroughRoute.mockClear();
    connection.sendRawTransaction.mockImplementation(async (bytes: unknown) => signatureOf(VersionedTransaction.deserialize(bytes as Uint8Array)));
  });

  it("pins Lighthouse to its mainnet program id (L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95)", () => {
    expect(LIGHTHOUSE_PROGRAM_ID.toBase58()).toBe("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
  });
  it.each(Object.entries(flows))("%s: Phantom's Lighthouse-guarded return passes the client check and is relayed", async (_flow, instructions) => {
    const prepared = prepare(instructions);
    const result = await sendFlow(prepared, phantom());
    expect(result.via).toBe("relay");
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    const sent = VersionedTransaction.deserialize(connection.sendRawTransaction.mock.calls[0]![0] as Uint8Array);
    expect(sent.message.compiledInstructions.map((compiled) => sent.message.staticAccountKeys[compiled.programIdIndex]!.toBase58()))
      .toContain("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
    expect(signatureOf(sent)).toBe(result.signature);
  });
  it.each(Object.entries(flows))("%s: an inserted SystemProgram.transfer next to Phantom's Lighthouse is refused by the client check and by tx-send", async (_flow, instructions) => {
    const prepared = prepare(instructions);
    const drain = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: attacker, lamports: 1_000_000_000 });
    await expect(sendFlow(prepared, phantom([drain]))).rejects.toThrow(/Wallet added an instruction from a program that is not allowed/);
    expect(relayThroughRoute).not.toHaveBeenCalled();
    const drained = await phantom([drain]).signTransaction(VersionedTransaction.deserialize(prepared.serialize()));
    if (needsMint(prepared)) drained.sign([mint]);
    const { status, json } = await call(relayBody(prepared, drained));
    expect(status).toBe(400); expect(json.sent).toBe(false);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("still refuses the lookalike id the allow-list used before (L2TExMF…GsqqY is not Lighthouse)", async () => {
    const prepared = prepare(flows["open (mint cosign)"]);
    const lookalike = new TransactionInstruction({ programId: new PublicKey("L2TExMFKdjpN9kozasaurPPf4nCVfRTb7cTZo5GsqqY"), keys: [], data: Buffer.from([1]) });
    await expect(sendFlow(prepared, phantom([lookalike]))).rejects.toThrow(/not allowed/);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});
