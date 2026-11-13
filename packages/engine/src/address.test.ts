import { describe, expect, it } from "vitest";
import { shortAddress } from "./address";

describe("shortAddress", () => {
  it("shortens a Solana address to first 4 and last 4 characters", () => {
    expect(shortAddress("DWDKWxxxxxxxxxxxxxxxxxxxxxxxxxxxxxQmTfa")).toBe("DWDK…mTfa");
  });

  it("shortens an EVM address to 0x plus 4 hex, then last 4", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
  });
});
