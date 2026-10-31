import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { buildTransaction, testKeypair, toBase64, BLOCKHASH } from "@/lib/test-support/send-fixtures";

const relay = vi.hoisted(() => ({ post: vi.fn() }));
const mint = vi.hoisted(() => ({ dispose: vi.fn(), keypair: null as null | { publicKey: unknown; secretKey: Uint8Array } }));
vi.mock("@/lib/jupiter/browser-relay", () => ({ postWithJupiterRelay: relay.post }));
vi.mock("@/lib/ephemeral-mint", () => ({ createEphemeralMint: () => ({ publicKey: mint.keypair!.publicKey, secretKey: mint.keypair!.secretKey, dispose: mint.dispose }) }));

import { TxNotSentError } from "@/lib/tx-pipeline";
import { addLiquidityAdapter } from "./add";
import { openPositionAdapter } from "./open";
import { decodePreparedTransaction } from "./shared";

const payer = testKeypair(31);
const WALLET = payer.publicKey.toBase58();
const mintKey = testKeypair(32);
const selection = { positionMint: testKeypair(33).publicKey.toBase58(), inputMint: "So11111111111111111111111111111111111111112", inputKind: "native" as const };
const reply = (body: unknown, status = 200) => relay.post.mockResolvedValueOnce(Response.json(body, { status }));

beforeEach(() => { relay.post.mockReset(); mint.dispose.mockReset(); mint.keypair = Keypair.fromSecretKey(mintKey.secretKey); });

describe("decodePreparedTransaction", () => {
  it("checks payer and blockhash", () => {
    const b64 = toBase64(buildTransaction({ payer, signWith: [] }));
    expect(decodePreparedTransaction(b64, WALLET, BLOCKHASH).message.recentBlockhash).toBe(BLOCKHASH);
    expect(() => decodePreparedTransaction(b64, testKeypair(1).publicKey.toBase58())).toThrow(TxNotSentError);
    expect(() => decodePreparedTransaction(b64, WALLET, "other")).toThrow(TxNotSentError);
  });
});

describe("add liquidity adapter", () => {
  const input = { selection, amount: "1", rawAmount: 1_000_000_000n, floorBps: 9900, toleranceBps: 50, relayStore: {} as never };
  const quote = { wallet: WALLET, ...selection, requested: "1000000000", floorBps: 9900, toleranceBps: 50 };
  const good = () => ({ simulated: true, quote, unsignedTransaction: toBase64(buildTransaction({ payer, signWith: [] })), blockhash: BLOCKHASH,
    lastValidBlockHeight: 123, startingLiquidity: "1", startingBalances: {} });
  it("prepares through the server's simulated prepare and returns the wallet-payable tx", async () => {
    reply(good());
    const prepared = await addLiquidityAdapter.prepare(input, { wallet: WALLET });
    expect(relay.post.mock.calls[0]![0]).toBe("/api/selected-prepare");
    expect(relay.post.mock.calls[0]![1]).toMatchObject({ wallet: WALLET, amount: "1", floorBps: 9900, toleranceBps: 50 });
    expect(prepared).toMatchObject({ lastValidBlockHeight: 123, positionMint: selection.positionMint });
    expect(prepared.cosign).toBeUndefined();
  });
  it("surfaces the server's plain refusal as not sent", async () => {
    reply({ error: "Pool is paused", code: "POOL_PAUSED" }, 400);
    await expect(addLiquidityAdapter.prepare(input, { wallet: WALLET })).rejects.toMatchObject({ name: "TxNotSentError", message: "Pool is paused", code: "POOL_PAUSED" });
  });
  it.each([
    ["unsimulated", { simulated: false }],
    ["other amount", { quote: { ...quote, requested: "5" } }],
    ["other tolerance", { quote: { ...quote, toleranceBps: 100 } }],
    ["other wallet", { quote: { ...quote, wallet: "x" } }],
  ])("refuses a %s quote", async (_name, patch) => {
    reply({ ...good(), ...patch });
    await expect(addLiquidityAdapter.prepare(input, { wallet: WALLET })).rejects.toThrow("quote changed");
  });
});

describe("open position adapter", () => {
  const input = { poolId: "pool", inputMint: "mintA", inputKind: "token" as const, amount: "2", requested: "2000",
    rangePreset: "balanced" as never, minPrice: "", maxPrice: "", relayStore: {} as never };
  const summary = (patch: Record<string, unknown> = {}) => ({ wallet: WALLET, poolId: "pool", nftMint: mintKey.publicKey.toBase58(), blockhash: BLOCKHASH,
    lastValidBlockHeight: 456, quote: { requested: "2000", inputMint: "mintA", inputKind: "token" }, ...patch });
  const tx = () => toBase64(buildTransaction({ payer, extraSigners: [mintKey], signWith: [] }));
  it("binds the fresh mint, cosigns after the wallet and disposes the secret", async () => {
    reply({ unsignedTransaction: tx(), summary: summary() });
    const prepared = await openPositionAdapter.prepare(input, { wallet: WALLET });
    expect(relay.post.mock.calls[0]![1]).toMatchObject({ nftMint: mintKey.publicKey.toBase58(), poolId: "pool" });
    const walletSigned = buildTransaction({ payer, extraSigners: [mintKey], signWith: [] }); walletSigned.sign([payer]);
    const signed = prepared.cosign!(walletSigned);
    expect(signed.signatures.every((s) => s.some((b) => b !== 0))).toBe(true);
    expect(() => prepared.cosign!(buildTransaction({ payer, extraSigners: [mintKey], signWith: [] }))).toThrow();
    prepared.dispose!(); expect(mint.dispose).toHaveBeenCalledTimes(1);
  });
  it("passes the step-1 swap signature and runs the last-moment gate", async () => {
    reply({ unsignedTransaction: tx(), summary: summary() });
    const beforeWallet = vi.fn(() => { throw new TxNotSentError("Check the original SOL swap"); });
    await expect(openPositionAdapter.prepare({ ...input, solSwapSignature: "sig1", beforeWallet }, { wallet: WALLET })).rejects.toThrow("original SOL swap");
    expect(relay.post.mock.calls[0]![1]).toMatchObject({ solSwapSignature: "sig1" });
    expect(mint.dispose).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["other mint", { nftMint: testKeypair(9).publicKey.toBase58() }],
    ["other pool", { poolId: "x" }],
    ["other amount", { quote: { requested: "1", inputMint: "mintA", inputKind: "token" } }],
  ])("refuses a summary with %s and disposes the mint", async (_name, patch) => {
    reply({ unsignedTransaction: tx(), summary: summary(patch) });
    await expect(openPositionAdapter.prepare(input, { wallet: WALLET })).rejects.toThrow("does not match your inputs");
    expect(mint.dispose).toHaveBeenCalledTimes(1);
  });
  it("disposes the mint on a prepare refusal", async () => {
    reply({ error: "Too much slippage" }, 400);
    await expect(openPositionAdapter.prepare(input, { wallet: WALLET })).rejects.toBeInstanceOf(TxNotSentError);
    expect(mint.dispose).toHaveBeenCalledTimes(1);
  });
});
