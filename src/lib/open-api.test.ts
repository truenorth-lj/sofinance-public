import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { PublicKey } from "@solana/web3.js";
import { parseOpenPrepareRequest, parseOpenQuoteRequest, parseOpenRange } from "./open-api";
import { testKeypair } from "./test-support/send-fixtures";

const wallet = testKeypair(1).publicKey.toBase58();
const poolId = "So11111111111111111111111111111111111111112";
const inputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const nftMint = testKeypair(6).publicKey.toBase58();
const quoteBody = { wallet, poolId, inputMint, inputKind: "token" as const, amount: "0.12", rangePreset: "standard" };

describe("parseOpenRange (web quote API)", () => {
  it("accepts the micro preset", () => {
    expect(parseOpenRange({ rangePreset: "micro" })).toEqual({ preset: "micro" });
  });

  it("still defaults to standard and parses custom bands", () => {
    expect(parseOpenRange({})).toEqual({ preset: "standard" });
    expect(parseOpenRange({ rangePreset: "custom", minPrice: "0.99", maxPrice: "1.01" }))
      .toEqual({ preset: "custom", minPrice: "0.99", maxPrice: "1.01" });
  });

  it("rejects unknown presets and incomplete custom ranges", () => {
    expect(() => parseOpenRange({ rangePreset: "yolo" })).toThrow(/micro, tight, standard, wide, or custom/);
    expect(() => parseOpenRange({ rangePreset: "custom", minPrice: "1" })).toThrow(/minPrice and maxPrice/);
  });
});

describe("parseOpenPrepareRequest", () => {
  it("requires a valid on-curve NFT mint and leaves quote parsing unsigned of that field", async () => {
    const quote = await parseOpenQuoteRequest(new Request("http://localhost/api/open-quote", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quoteBody),
    }));
    expect(quote).not.toHaveProperty("nftMint");
    const prepared = await parseOpenPrepareRequest(new Request("http://localhost/api/open-prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...quoteBody, nftMint }),
    }));
    expect(prepared.nftMint).toBe(new PublicKey(nftMint).toBase58());
  });

  it("rejects a missing or invalid NFT mint", async () => {
    await expect(parseOpenPrepareRequest(new Request("http://localhost/api/open-prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(quoteBody),
    }))).rejects.toThrow("Position NFT mint is required");
    await expect(parseOpenPrepareRequest(new Request("http://localhost/api/open-prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...quoteBody, nftMint: "not-a-mint" }),
    }))).rejects.toThrow("Invalid position NFT mint");
    await expect(parseOpenPrepareRequest(new Request("http://localhost/api/open-prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...quoteBody, nftMint: PublicKey.default.toBase58() }),
    }))).rejects.toThrow("Invalid position NFT mint");
  });
});
