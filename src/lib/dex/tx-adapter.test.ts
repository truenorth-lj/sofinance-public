import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { afterEach, describe, expect, it } from "vitest";
import { setFetchReplay } from "@/lib/test-support/offline-fetch";
import { createJupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { TxNotSentError } from "@/lib/tx-pipeline";
import { dexTxAdapter } from "./tx-adapter";
import type { DexDescriptor } from "./types";

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(7));
const blockhash = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey.toBase58();
const descriptor = (positionCosigner: DexDescriptor["meta"]["positionCosigner"]) => ({ id: "some-dex", meta: { positionCosigner } }) as unknown as DexDescriptor;
const request = { poolId: "Pool1111111111111111111111111111111111111111", range: { kind: "preset" as const, presetId: "standard" }, input: { token: "Mint111111111111111111111111111111111111111", amountRaw: "100" }, slippageBps: 50 };
const tx = (payer: PublicKey, extraSigner?: PublicKey) => Buffer.from(new VersionedTransaction(new TransactionMessage({
  payerKey: payer, recentBlockhash: blockhash,
  instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1000 }),
    ...(extraSigner ? [new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [{ pubkey: extraSigner, isSigner: true, isWritable: true }], data: Buffer.alloc(0) })] : [])],
}).compileToV0Message()).serialize()).toString("base64");

let restore: (() => void) | undefined;
afterEach(() => restore?.());
function serve(respond: (url: string, body: Record<string, unknown>) => { status?: number; body: unknown }) {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  restore = setFetchReplay(async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ url, body });
    const out = respond(url, body);
    return Response.json(out.body, { status: out.status ?? 200 });
  });
  return seen;
}
const input = (cosigner: DexDescriptor["meta"]["positionCosigner"], step = 1) =>
  ({ descriptor: descriptor(cosigner), context: { step, priorSignatures: [] }, relayStore: createJupiterRelayStore(), request });

describe("dexTxAdapter", () => {
  it("creates the browser cosigner on step 1, sends only its public key, and signs after the wallet", async () => {
    const seen = serve((_url, body) => {
      const cosigner = new PublicKey((body.request as { cosigner: string }).cosigner);
      return { body: { step: 1, of: 2, label: "Set up", done: false, planToken: "p", prepared: { kind: "solana-tx", transaction: tx(wallet.publicKey, cosigner), lastValidBlockHeight: 9, cosignRef: cosigner.toBase58(), sendPermit: "s", landedPermit: "l" } } };
    });
    const prepared = await dexTxAdapter("open").prepare(input("ephemeral-keypair"), { wallet: wallet.publicKey.toBase58() });
    expect(seen[0]!.url).toBe("/api/dex/some-dex/open");
    expect(seen[0]!.body).toMatchObject({ step: 1, priorSignatures: [], request: { owner: wallet.publicKey.toBase58() } });
    expect(JSON.stringify(seen[0]!.body)).not.toMatch(/secret/i);
    expect(prepared).toMatchObject({ lastValidBlockHeight: 9, sendPermit: "s", landedPermit: "l", result: { planToken: "p" } });
    prepared.transaction.sign([wallet]);
    const signed = prepared.cosign!(prepared.transaction);
    expect(signed.signatures.every((signature) => signature.some((byte) => byte !== 0))).toBe(true);
    prepared.dispose?.();
  });

  it("sends no cosigner when the DEX needs none, and refuses an unexpected extra signer", async () => {
    const stranger = Keypair.generate().publicKey;
    const seen = serve(() => ({ body: { step: 1, of: 1, label: "x", done: true, prepared: { kind: "solana-tx", transaction: tx(wallet.publicKey, stranger), lastValidBlockHeight: 9 } } }));
    await expect(dexTxAdapter("open").prepare(input("none"), { wallet: wallet.publicKey.toBase58() })).rejects.toBeInstanceOf(TxNotSentError);
    expect((seen[0]!.body.request as Record<string, unknown>).cosigner).toBeUndefined();
  });

  it("refuses a step paid by another wallet", async () => {
    serve(() => ({ body: { step: 1, of: 1, label: "x", done: true, prepared: { kind: "solana-tx", transaction: tx(Keypair.generate().publicKey), lastValidBlockHeight: 9 } } }));
    await expect(dexTxAdapter("open").prepare(input("none"), { wallet: wallet.publicKey.toBase58() })).rejects.toThrow(/does not match your wallet/);
  });

  it("surfaces the route's plain-English error and code", async () => {
    serve(() => ({ status: 422, body: { error: "This range is not available to open yet.", code: "RANGE_UNSUPPORTED" } }));
    await expect(dexTxAdapter("open").prepare(input("none"), { wallet: wallet.publicKey.toBase58() })).rejects.toMatchObject({ message: "This range is not available to open yet.", code: "RANGE_UNSUPPORTED" });
  });

  it("prepares a recovery step from the position key", async () => {
    const seen = serve(() => ({ body: { step: 1, of: 1, label: "Close", done: true, prepared: { kind: "solana-tx", transaction: tx(wallet.publicKey), lastValidBlockHeight: 9 } } }));
    const adapter = dexTxAdapter("recovery");
    expect(adapter.flow).toBe("withdraw");
    const prepared = await adapter.prepare({ descriptor: descriptor("ephemeral-keypair"), context: { step: 1, priorSignatures: [] }, relayStore: createJupiterRelayStore(), positionKey: "some-dex:abc" as never }, { wallet: wallet.publicKey.toBase58() });
    expect(seen[0]!.url).toBe("/api/dex/some-dex/recovery");
    expect(seen[0]!.body).toMatchObject({ wallet: wallet.publicKey.toBase58(), positionKey: "some-dex:abc" });
    expect(prepared.cosign).toBeUndefined();
  });

  it("prepares add / withdraw / claim / compound with the owner and only that op's fields (the route's strict bodies), with their own flow and toast", async () => {
    const seen = serve(() => ({ body: { step: 1, of: 1, label: "x", done: true, prepared: { kind: "solana-tx", transaction: tx(wallet.publicKey), lastValidBlockHeight: 9 } } }));
    const owner = wallet.publicKey.toBase58();
    const base = { descriptor: descriptor("ephemeral-keypair"), context: { step: 1, priorSignatures: [] }, relayStore: createJupiterRelayStore(), positionKey: "some-dex:abc" as never };
    const add = dexTxAdapter("add");
    const withdraw = dexTxAdapter("withdraw");
    const claim = dexTxAdapter("claim");
    const compound = dexTxAdapter("compound");
    await add.prepare({ ...base, input: { token: "Mint111111111111111111111111111111111111111", amountRaw: "100" } }, { wallet: owner });
    await withdraw.prepare({ ...base, fraction: 0.25, output: "pool-tokens" }, { wallet: owner });
    const claimed = await claim.prepare(base, { wallet: owner });
    await compound.prepare(base, { wallet: owner });
    expect(seen.map((item) => item.url)).toEqual(["/api/dex/some-dex/add", "/api/dex/some-dex/withdraw", "/api/dex/some-dex/claim", "/api/dex/some-dex/compound"]);
    const step = { step: 1, priorSignatures: [] };
    expect(seen[0]!.body).toEqual({ owner, positionKey: "some-dex:abc", input: { token: "Mint111111111111111111111111111111111111111", amountRaw: "100" }, ...step });
    expect(seen[1]!.body).toEqual({ owner, positionKey: "some-dex:abc", fraction: 0.25, output: "pool-tokens", ...step });
    expect(seen[2]!.body).toEqual({ owner, positionKey: "some-dex:abc", ...step });
    expect(seen[3]!.body).toEqual({ owner, positionKey: "some-dex:abc", ...step });
    expect(claimed.cosign).toBeUndefined(); // only step 1 of an open makes a cosigner
    expect([add.flow, withdraw.flow, claim.flow, compound.flow]).toEqual(["add", "withdraw", "claim", "compound"]);
    expect([add.successTitle, withdraw.successTitle, claim.successTitle, compound.successTitle]).toEqual(["Liquidity added", "Withdrawal confirmed", "Fees claimed", "Fees compounded"]);
  });
});
