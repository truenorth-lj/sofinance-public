import { describe, expect, it } from "vitest";
import { isSameAssetPair, type RegistryToken } from "./token-registry";

const solanaToken: RegistryToken = {
  chain: "solana",
  address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  symbol: "USDC",
  issuer: "issuer-a",
  underlying: "USD",
  verification: { method: "allowlist" },
};

describe("isSameAssetPair", () => {
  it("keeps Solana mints distinct when their addresses differ only in case", () => {
    const otherMint = "EPjfWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(isSameAssetPair(solanaToken, { ...solanaToken, address: otherMint })).toBe(false);
    expect(isSameAssetPair(solanaToken, { ...solanaToken, issuer: "issuer-b" })).toBe(false);
    expect(isSameAssetPair(solanaToken, { ...solanaToken, address: otherMint, issuer: "issuer-b" })).toBe(true);
  });

  it("treats different case spellings of an RHC address as one token", () => {
    const a = { ...solanaToken, chain: "robinhood", address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa" } as const;
    const b = { ...a, address: a.address.toLowerCase(), issuer: "issuer-b" };
    expect(isSameAssetPair(a, b)).toBe(false);
  });
});
