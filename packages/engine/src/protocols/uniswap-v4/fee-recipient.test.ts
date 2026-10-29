import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { parseRhcFeeRecipient, RHC_FEE_WALLET_ENV } from "./fee-recipient";

// Dummy addresses only: the real fee wallet is never in the repo.
const DUMMY = getAddress("0x00000000000000000000000000000000000fee01");
const MIXED = getAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");

describe("parseRhcFeeRecipient (RHC_UNIV4_FEE_WALLET)", () => {
  it("names the server-only env var", () => {
    expect(RHC_FEE_WALLET_ENV).toBe("RHC_UNIV4_FEE_WALLET");
  });
  it("accepts an EIP-55 checksummed address (trimmed)", () => {
    expect(parseRhcFeeRecipient(DUMMY)).toBe(DUMMY);
    expect(parseRhcFeeRecipient(` ${MIXED}\n`)).toBe(MIXED);
  });
  it.each([undefined, null, "", "   ", "not-an-address", "0x1234", MIXED.toLowerCase(), `0x${MIXED.slice(2).toUpperCase()}`,
    `${MIXED.slice(0, -1)}${MIXED.at(-1) === "d" ? "D" : "d"}`, "0x0000000000000000000000000000000000000000"])("rejects %j", raw => {
    expect(parseRhcFeeRecipient(raw)).toBeNull();
  });
});
