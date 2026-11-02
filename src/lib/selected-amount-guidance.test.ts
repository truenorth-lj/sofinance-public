import { describe, expect, it } from "vitest";
import { addAmountGuidance, AMOUNT_ABOVE_ZERO_MESSAGE, AMOUNT_NOT_A_NUMBER_MESSAGE, CLOSED_POSITION_ADD_MESSAGE, ENTER_AMOUNT_MESSAGE, tooManyDecimalsMessage } from "./selected-amount-guidance";

describe("addAmountGuidance (PR10: the real cause, never \"matching asset precision\")", () => {
  it("a fully withdrawn position (liquidity 0) says so, whatever the amount field holds", () => {
    expect(addAmountGuidance("", 6, "0")).toBe(CLOSED_POSITION_ADD_MESSAGE);
    expect(addAmountGuidance("1", 6, "0")).toBe(CLOSED_POSITION_ADD_MESSAGE);
  });
  it("names each amount problem", () => {
    expect(addAmountGuidance("  ", 6, "5")).toBe(ENTER_AMOUNT_MESSAGE);
    expect(addAmountGuidance("0", 6)).toBe(AMOUNT_ABOVE_ZERO_MESSAGE);
    expect(addAmountGuidance("1.1234567", 6)).toBe(tooManyDecimalsMessage(6));
    expect(addAmountGuidance("1.5", 0)).toBe("This token has no decimal places. Enter a whole number.");
    expect(addAmountGuidance("abc", 6)).toBe(AMOUNT_NOT_A_NUMBER_MESSAGE);
  });
  it("a usable amount has no guidance", () => {
    expect(addAmountGuidance("1.123456", 6, "10")).toBeNull();
  });
  it("no message mentions \"precision\"", () => {
    for (const input of ["", "0", "1.1234567", "x"]) expect(addAmountGuidance(input, 6) ?? "").not.toMatch(/precision/i);
  });
});
