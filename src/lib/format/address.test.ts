import { describe, expect, it } from "vitest";
import { shortAddress } from "./address";
import { blockscoutTxUrl, RHC_EXPLORER_TX, solscanAccountUrl, solscanTxUrl } from "./explorer";

describe("shortAddress", () => {
  it("shortens a Solana address to first 4 and last 4 characters", () => {
    expect(shortAddress("DWDKWxxxxxxxxxxxxxxxxxxxxxxxxxxxxxQmTfa")).toBe("DWDK…mTfa");
    expect(shortAddress("XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB")).toBe("XsDo…HzoB");
  });

  it("shortens an EVM address to 0x plus 4 hex, then last 4", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortAddress("0xb95b000000000000000000000000000000001b04")).toBe("0xb95b…1b04");
    expect(shortAddress("0x2222222222222222222222222222222222222222")).toBe("0x2222…2222");
  });

  it("leaves strings too short to shorten unchanged", () => {
    expect(shortAddress("abcd")).toBe("abcd");
    expect(shortAddress("12345678")).toBe("12345678");
    expect(shortAddress("0x12345678")).toBe("0x12345678");
  });

  it("trims whitespace before shortening", () => {
    expect(shortAddress("  1234567890  ")).toBe("1234…7890");
    expect(shortAddress("  0x1234567890abcdef1234567890abcdef12345678  ")).toBe("0x1234…5678");
  });
});

describe("explorer urls", () => {
  it("builds Solscan and Blockscout links", () => {
    expect(solscanTxUrl("abcSig")).toBe("https://solscan.io/tx/abcSig");
    expect(solscanAccountUrl("SomeMint")).toBe("https://solscan.io/account/SomeMint");
    expect(blockscoutTxUrl("0xhash")).toBe(`${RHC_EXPLORER_TX}0xhash`);
    expect(blockscoutTxUrl("0xhash")).toBe("https://robinhoodchain.blockscout.com/tx/0xhash");
  });
});
