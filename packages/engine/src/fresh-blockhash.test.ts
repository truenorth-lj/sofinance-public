import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { PREPARE_STALE_MS, QUOTE_TTL_MS } from "./ids";
import { prepareIsStale, preparedAtMs, quoteWindow, restampVersionedTransaction, stampPreparedBlockhash } from "./fresh-blockhash";

describe("prepared quote window", () => {
  it("stamps simulatedAt and expiresAt from the shared client TTL", () => {
    const now = 1_700_000_000_000;
    expect(quoteWindow(now)).toEqual({ simulatedAt: now, expiresAt: now + QUOTE_TTL_MS });
    expect(QUOTE_TTL_MS).toBe(75_000);
    expect(stampPreparedBlockhash({ blockhash: "hash", lastValidBlockHeight: 99 }, now)).toEqual({
      blockhash: "hash", lastValidBlockHeight: 99, simulatedAt: now, expiresAt: now + 75_000,
    });
  });

  it("treats a prepare older than 20s as stale, including recovery summaries without simulatedAt", () => {
    const now = 1_000_000;
    expect(PREPARE_STALE_MS).toBe(20_000);
    expect(prepareIsStale({ simulatedAt: now - 19_999, expiresAt: now + 55_000 }, now)).toBe(false);
    expect(prepareIsStale({ simulatedAt: now - 20_000, expiresAt: now + 55_000 }, now)).toBe(true);
    expect(preparedAtMs({ expiresAt: now + QUOTE_TTL_MS })).toBe(now);
    expect(prepareIsStale({ expiresAt: now + QUOTE_TTL_MS - PREPARE_STALE_MS }, now)).toBe(true);
  });
});

describe("restampVersionedTransaction", () => {
  it("rebuilds the message with a later blockhash without changing payer or instructions", () => {
    const payer = Keypair.generate();
    const destination = Keypair.generate().publicKey;
    const first = Keypair.generate().publicKey.toBase58();
    const second = Keypair.generate().publicKey.toBase58();
    const original = new VersionedTransaction(new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: first,
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: destination, lamports: 1 })],
    }).compileToV0Message());
    const restamped = restampVersionedTransaction(original, second);
    expect(restamped.message.recentBlockhash).toBe(second);
    expect(restamped.message.staticAccountKeys[0]?.toBase58()).toBe(payer.publicKey.toBase58());
    expect(restamped.message.compiledInstructions).toHaveLength(original.message.compiledInstructions.length);
    expect(original.message.recentBlockhash).toBe(first);
  });
});
