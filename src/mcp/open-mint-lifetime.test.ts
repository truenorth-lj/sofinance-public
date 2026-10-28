import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ build: vi.fn(), secret: vi.fn() }));
vi.mock("@sofinance/engine/open-atomic", async original => ({
  ...await original<typeof import("@sofinance/engine/open-atomic")>(), buildAndSimulateOpenPosition: backend.build,
}));
vi.mock("@sofinance/engine/config/server-env", async original => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(), getSigningSecret: backend.secret,
}));
import { buildTransaction, openSummaryFixture, SIGNING_SECRET, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import * as tokens from "@/lib/pending-sign-token";
import { prepareOpenPosition } from "./tools";
import { prepareOpenPositionSchema } from "./schemas";
import { VALID_ARGS } from "./test-support/dispatch-fixtures";
const payer = testKeypair(1);
let secrets: Array<() => Uint8Array>;
let tokenSawCleared: boolean;
let preparedBytes: string;
const cleared = () => secrets.every(read => read().every(byte => byte === 0));
const input = () => ({ ...prepareOpenPositionSchema.parse(VALID_ARGS.prepare_open_position), wallet: payer.publicKey.toBase58(), nftMint: undefined });
beforeEach(() => {
  secrets = []; tokenSawCleared = false; vi.resetAllMocks();
  const generate = Keypair.generate;
  vi.spyOn(Keypair, "generate").mockImplementation(() => { const key = generate(); secrets.push(() => key.secretKey); return key; });
  const keyPair = nacl.sign.keyPair;
  vi.spyOn(nacl.sign, "keyPair").mockImplementation(() => { const key = keyPair(); const secret = key.secretKey; secrets.push(() => secret); return key; });
  backend.secret.mockReturnValue(SIGNING_SECRET);
  backend.build.mockImplementation(async (...args: unknown[]) => {
    const mint = new PublicKey((args[6] as { nftMint: string }).nftMint);
    const transaction = buildTransaction({ payer, extraSigners: [{ publicKey: mint } as Keypair], signWith: [] });
    preparedBytes = toBase64(transaction);
    return { transaction, summary: openSummaryFixture({ wallet: payer.publicKey.toBase58(), nftMint: mint.toBase58(), blockhash: transaction.message.recentBlockhash }) };
  });
  const createToken = tokens.createSignToken;
  vi.spyOn(tokens, "createSignToken").mockImplementation((...args) => {
    tokenSawCleared = cleared();
    return createToken(...args);
  });
});
afterEach(() => { const zeroed = cleared(); vi.restoreAllMocks(); expect(zeroed).toBe(true); });

it("clears fallback mint before async sign-token creation and returns a valid mint-only signature", async () => {
  const result = await prepareOpenPosition(input());
  expect(secrets).toHaveLength(1); expect(tokenSawCleared).toBe(true);
  const tx = VersionedTransaction.deserialize(Buffer.from(result.unsignedTransaction, "base64"));
  expect(tx.signatures[0]!.every(byte => byte === 0)).toBe(true);
  expect(nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[1]!, tx.message.staticAccountKeys[1]!.toBytes())).toBe(true);
  expect(await tokens.verifySignToken(result.signToken, SIGNING_SECRET)).toMatchObject({ unsignedTransaction: result.unsignedTransaction, permit: result.permit });
});

it.each(["prepare", "deserialize", "sign", "serialize", "token"] as const)("clears fallback mint after %s failure", async failure => {
  if (failure === "prepare") backend.build.mockRejectedValue(new Error("synthetic prepare failure"));
  if (failure === "deserialize") vi.spyOn(VersionedTransaction, "deserialize").mockImplementation(() => { throw new Error("synthetic deserialize failure"); });
  if (failure === "sign") vi.spyOn(VersionedTransaction.prototype, "sign").mockImplementation(() => { throw new Error("synthetic sign failure"); });
  if (failure === "serialize") {
    const serialize = VersionedTransaction.prototype.serialize;
    vi.spyOn(VersionedTransaction.prototype, "serialize").mockImplementation(function (this: VersionedTransaction) {
      if (this.signatures[1]?.some(byte => byte !== 0)) {
        expect(cleared()).toBe(true);
        throw new Error("synthetic serialize failure");
      }
      return serialize.call(this);
    });
  }
  if (failure === "token") vi.mocked(tokens.createSignToken).mockImplementation(async () => {
    expect(cleared()).toBe(true); throw new Error("synthetic token failure");
  });
  await expect(prepareOpenPosition(input())).rejects.toThrow(`synthetic ${failure} failure`);
  expect(secrets).toHaveLength(1); expect(cleared()).toBe(true);
});

it("supplied mint never generates or signs a server mint and keeps bytes unchanged", async () => {
  const result = await prepareOpenPosition({ ...input(), nftMint: testKeypair(2).publicKey.toBase58() });
  expect(secrets).toHaveLength(0);
  expect(nacl.sign.keyPair).not.toHaveBeenCalled(); expect(Keypair.generate).not.toHaveBeenCalled();
  expect(result.unsignedTransaction).toBe(preparedBytes);
  const tx = VersionedTransaction.deserialize(Buffer.from(result.unsignedTransaction, "base64"));
  expect(tx.signatures.every(sig => sig.every(byte => byte === 0))).toBe(true);
});
