import { describe, expect, it } from "vitest";
import { shortAddress } from "./address";
import { blockscoutTxUrl, RHC_EXPLORER_TX, solscanAccountUrl, solscanTxUrl } from "./explorer";

describe("shortAddress", () => {
  it("uses first 4 and last 4 characters", () => {
    expect(shortAddress("DWDKWxxxxxxxxxxxxxxxxxxxxxxxxxxxxxQmTfa")).toBe("DWDK…mTfa");
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x12…5678");
  });
  it("leaves strings of 8 or fewer characters unchanged", () => {
    expect(shortAddress("abcd")).toBe("abcd");
    expect(shortAddress("12345678")).toBe("12345678");
  });
  it("trims whitespace before shortening", () => {
    expect(shortAddress("  1234567890  ")).toBe("1234…7890");
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
