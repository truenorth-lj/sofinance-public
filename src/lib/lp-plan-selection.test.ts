import { describe, expect, it } from "vitest";
import { parsePairLabel, parseSolanaAddress, pairLabelFromSymbols } from "./lp-plan-selection";

const POOL = "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro";

describe("plan pool selection", () => {
  it("accepts a Solana address and rejects junk", () => {
    expect(parseSolanaAddress(POOL)).toBe(POOL);
    expect(parseSolanaAddress(` ${POOL} `)).toBe(POOL);
    expect(parseSolanaAddress("SPCXx/SPCX")).toBeUndefined();
    expect(parseSolanaAddress("")).toBeUndefined();
    expect(parseSolanaAddress("O0")).toBeUndefined();
  });

  it("keeps a pair label and refuses to treat an address as one", () => {
    expect(parsePairLabel("SPCXx/SPCX")).toBe("SPCXx/SPCX");
    expect(parsePairLabel(POOL)).toBeUndefined();
    expect(parsePairLabel("")).toBeUndefined();
    expect(pairLabelFromSymbols("SPCXx", "SPCX")).toBe("SPCXx/SPCX");
  });
});
