import { describe, expect, it } from "vitest";
import { assertImpactConfirmed, capReceivedAmount, principalMinimum, estimateUSDC, impactFlags, percentToBps, shouldSwap, targetUSDCToBps, transactionCount, withdrawFullEstimateUsd } from "./quote";
import { withdrawPermit } from "./permit";
import { createPermit } from "../auth/permit";
describe("withdraw quote math", () => {
    it("converts percent and rounds target estimates up", () => {
        expect(percentToBps(1.1)).toBe(110);
        expect(percentToBps(25.5)).toBe(2550);
        expect(estimateUSDC(2550, 200)).toBe(51);
        expect(targetUSDCToBps(51, 200)).toBe(2550);
        expect(targetUSDCToBps(1, 3)).toBe(3334);
        expect(targetUSDCToBps(.01, 200)).toBe(100);
    });
    it("rejects invalid amounts instead of clamping above full withdrawal", () => {
        for (const p of [0, 101, NaN, Infinity, 1.001])
            expect(() => percentToBps(p)).toThrow();
        for (const [target, total] of [[0, 1], [2, 1], [1, 0], [Infinity, 2]])
            expect(() => targetUSDCToBps(target!, total!)).toThrow();
    });
    it("charges only conversions", () => {
        expect(shouldSwap("original", "A", "USDC")).toBe(false);
        expect(shouldSwap("usdc", "USDC", "USDC")).toBe(false);
        expect(shouldSwap("token", "A", "A")).toBe(false);
        expect(shouldSwap("usdc", "A", "USDC")).toBe(true);
        expect(shouldSwap("token", "A", "B")).toBe(true);
    });
    it("uses strict impact thresholds and requires explicit confirmation", () => {
        expect(impactFlags(200)).toEqual({ warning: false, requiresSecondConfirmation: false });
        expect(impactFlags(201)).toEqual({ warning: true, requiresSecondConfirmation: false });
        expect(impactFlags(500).requiresSecondConfirmation).toBe(false);
        expect(() => assertImpactConfirmed(impactFlags(501))).toThrow();
        expect(() => assertImpactConfirmed(impactFlags(501), true)).not.toThrow();
        expect(() => impactFlags(NaN)).toThrow();
    });
    it("enforces principal floors and caps swaps at actual receipts", () => {
        expect(principalMinimum(10000n, 5000, 50)).toBe(4975n);
        expect(capReceivedAmount(100n, 110n, 95n)).toBe(100n);
        expect(capReceivedAmount(120n, 110n, 95n)).toBe(110n);
        expect(() => capReceivedAmount(94n, 110n, 95n)).toThrow();
    });
    it("splits only oversized conversions", () => {
        expect(transactionCount(1232, true)).toBe(1);
        expect(transactionCount(1233, true)).toBe(2);
        expect(() => transactionCount(1233, false)).toThrow();
    });
});
describe("withdraw permit", () => {
    const input = { wallet: "owner", message: "message", summary: { operation: "withdraw", stage: "withdraw", assets: [{ amount: "100" }], requiresSecondConfirmation: true } };
    it("binds amounts, stage, impact, and message", () => {
        const permit = withdrawPermit.issue("secret", input);
        expect(withdrawPermit.verify("secret", input, permit)).toBe(true);
        expect(withdrawPermit.verify("secret", { ...input, message: "changed" }, permit)).toBe(false);
        expect(withdrawPermit.verify("secret", { ...input, summary: { ...input.summary, stage: "swap" } }, permit)).toBe(false);
        expect(withdrawPermit.verify("secret", { ...input, summary: { ...input.summary, assets: [{ amount: "101" }] } }, permit)).toBe(false);
        expect(withdrawPermit.verify("secret", { ...input, summary: { ...input.summary, requiresSecondConfirmation: false } }, permit)).toBe(false);
        expect(withdrawPermit.verify("secret", input, "bad")).toBe(false);
        expect(createPermit("sofinance:open-position:v1").verify("secret", input, permit)).toBe(false);
    });
});

describe("withdraw full estimate (X3-5, targetUSDC only)", () => {
    // SNDK-type: ×8 ScaledUiAmount stock, Jupiter $78.63 per share → $629.04 per raw / 10^decimals; USDC on the other side.
    const sndk = { currentAmounts: { a: "2890000", b: "100000000" }, decimalsA: 6, decimalsB: 6,
        displayPricing: { usdPerRawUnitA: 78.63 * 8, usdPerRawUnitB: 1 } };
    it("values each side as raw / 10^decimals × USD per raw unit (multiplier already applied)", () => {
        expect(withdrawFullEstimateUsd(sndk)).toBeCloseTo(2.89 * 629.04 + 100, 6);
    });
    it("a $500 target maps to the share of the multiplier-aware estimate, not of a per-share (×1) one", () => {
        const full = withdrawFullEstimateUsd(sndk);
        expect(targetUSDCToBps(500, full)).toBe(Math.ceil(500 / full * 10000));
        // The old per-share estimate (2.89 × 78.63 + 100 ≈ $327) would reject $500 as larger than the position.
        expect(() => targetUSDCToBps(500, 2.89 * 78.63 + 100)).toThrow("Target must be within the position estimate");
    });
    it("an unpriced side gives 0, so any target is rejected (never valued at a guess)", () => {
        for (const displayPricing of [undefined, { usdPerRawUnitA: null, usdPerRawUnitB: 1 }, { usdPerRawUnitA: 1, usdPerRawUnitB: Number.NaN }]) {
            const full = withdrawFullEstimateUsd({ ...sndk, displayPricing });
            expect(full).toBe(0);
            expect(() => targetUSDCToBps(1, full)).toThrow("Target must be within the position estimate");
        }
    });
});
