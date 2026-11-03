import { describe, expect, it } from "vitest";
import { parseTokenAmount } from "@sofinance/engine/amount";
import { depositTooSmallMessage, minimumDisplay } from "./deposit-minimum";

const USDC = { id: "usdc", decimals: 6, symbol: "USDC" };
/** The same "too small" comparison the server makes with the threshold (minimum.server.ts: `amount < minimum`). */
const passes = (amount: bigint, minimumRaw: bigint) => !(amount < minimumRaw);

describe("depositTooSmallMessage (shared by Open and Add)", () => {
  it("shows the threshold itself, rounded up to 3 significant figures, with no buffer", () => {
    expect(minimumDisplay(25_119n, 6)).toBe("0.0252"); // prod local minimum (TSLAx/TSLA, Nov 3)
    expect(minimumDisplay(25_081n, 6)).toBe("0.0251");
    expect(minimumDisplay(48_336n, 6)).toBe("0.0484");
    expect(minimumDisplay(25_100n, 6)).toBe("0.0251"); // already 3 figures: unchanged
    expect(minimumDisplay(100_000n, 6)).toBe("0.1");
    expect(minimumDisplay(63n, 6)).toBe("0.000063"); // 3 digits or fewer: exact
    expect(minimumDisplay(9n, 6)).toBe("0.000009");
    expect(minimumDisplay(2_000_001n, 6)).toBe("2.01");
    expect(minimumDisplay(123_456n, 0)).toBe("124000");
    expect(minimumDisplay(0n, 6)).toBe("0");
  });

  it("the shown number is at or above the threshold, and entering it always passes (no slack beyond the rounding)", () => {
    let seed = 0x5eed;
    const next = () => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed; };
    const cases: [bigint, number][] = [[1n, 6], [999n, 6], [1_000n, 6], [1_001n, 6], [25_119n, 6], [48_336n, 6], [99_999n, 6], [100_001n, 9], [7n, 0]];
    for (let i = 0; i < 2_000; i++) cases.push([BigInt(next()) * BigInt(1 + (next() % 1_000)) + 1n, next() % 10]);
    for (const [minimumRaw, decimals] of cases) {
      const shown = minimumDisplay(minimumRaw, decimals);
      const entered = parseTokenAmount(shown, decimals);
      expect(entered >= minimumRaw, `${minimumRaw} @${decimals} → ${shown}`).toBe(true);
      expect(passes(entered, minimumRaw)).toBe(true);
      // Smallest 3-figure amount ≥ the threshold: one unit of the 3rd figure less would be below it.
      const digits = minimumRaw.toString().length;
      const step = digits > 3 ? 10n ** BigInt(digits - 3) : 1n;
      expect(entered - minimumRaw < step, `${minimumRaw} → ${shown} adds more than rounding`).toBe(true);
    }
  });

  it("says the amount is too small with the threshold, only for the same token and only when too small", () => {
    expect(depositTooSmallMessage({ token: "usdc", tooSmall: true, minimumRaw: "25119" }, USDC))
      .toBe("This amount is too small to add to every price step in this range. Try at least 0.0252 USDC.");
    expect(depositTooSmallMessage({ token: "usdc", tooSmall: true, minimumRaw: "48336" }, USDC))
      .toBe("This amount is too small to add to every price step in this range. Try at least 0.0484 USDC.");
    expect(depositTooSmallMessage({ token: "usdc", tooSmall: true, minimumRaw: null }, USDC))
      .toBe("This amount is too small to add to every price step in this range. Try a larger amount.");
    expect(depositTooSmallMessage({ token: "usdc", tooSmall: false, minimumRaw: null }, USDC)).toBeNull();
    expect(depositTooSmallMessage({ token: "other", tooSmall: true, minimumRaw: "48336" }, USDC)).toBeNull();
    expect(depositTooSmallMessage(undefined, USDC)).toBeNull();
    expect(depositTooSmallMessage({ token: "usdc", tooSmall: true, minimumRaw: "48336" }, { ...USDC, symbol: null }))
      .toBe("This amount is too small to add to every price step in this range. Try at least 0.0484.");
  });
});
