import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("@/lib/jupiter/browser-relay", () => ({ postWithJupiterRelay: (...args: unknown[]) => post(...args) }));

const { spotSwapTxAdapter } = await import("./spot-swap-client");
const { TxNotSentError } = await import("@/lib/tx-pipeline");

const wallet = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey.toBase58();
const unsigned = Buffer.from(new VersionedTransaction(new TransactionMessage({
  payerKey: wallet, recentBlockhash: Keypair.generate().publicKey.toBase58(),
  instructions: [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wallet, lamports: 0 })],
}).compileToV0Message()).serialize()).toString("base64");
const summary = (minOut: string) => ({ wallet: wallet.toBase58(), outputMint: mint, amount: "2000000", quotedOut: "4500000", minOut,
  outputDecimals: 8, outputSymbol: "TSLAx", lastValidBlockHeight: 999 });
const input = (overrides = {}) => ({ underlying: "TSLA", mint, amount: "2", minOut: "4477500", store: {} as never, ...overrides });
const prepare = (value = input()) => spotSwapTxAdapter.prepare(value, { wallet: wallet.toBase58() } as never);

beforeEach(() => post.mockReset());

describe("spotSwapTxAdapter.prepare: the confirmed minimum", () => {
  it("sends the minimum the user saw and accepts a prepared minimum at least as high", async () => {
    post.mockResolvedValue(Response.json({ unsignedTransaction: unsigned, summary: summary("4477500") }));
    const prepared = await prepare();
    expect(post).toHaveBeenCalledWith("/api/spot-swap-prepare", expect.objectContaining({ minOut: "4477500", amount: "2", mint }), expect.anything());
    expect(prepared.summary.minOut).toBe("4477500");
  });

  it("refuses a prepared minimum below the one the user saw, even if the server returned it", async () => {
    post.mockResolvedValue(Response.json({ unsignedTransaction: unsigned, summary: summary("2238750") }));
    await expect(prepare()).rejects.toBeInstanceOf(TxNotSentError);
  });

  it("hands the new terms to the modal when the server says the price moved, and sends nothing", async () => {
    const terms = { quotedOut: "2250000", minOut: "2238750", priceImpactPct: "0.0009" };
    post.mockResolvedValue(Response.json({ error: "The price moved since your quote, so nothing was prepared. Check the new amount and press Buy again.",
      code: "spot_swap_quote_changed", quote: terms }, { status: 400 }));
    const onQuoteChanged = vi.fn();
    await expect(prepare(input({ onQuoteChanged }))).rejects.toThrow(/price moved/);
    expect(onQuoteChanged).toHaveBeenCalledWith(terms);
  });

  it("refuses to ask the server without a confirmed minimum", async () => {
    await expect(prepare(input({ minOut: "" }))).rejects.toBeInstanceOf(TxNotSentError);
    expect(post).not.toHaveBeenCalled();
  });
});
