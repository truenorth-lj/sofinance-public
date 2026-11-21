import { exceedsTxSizeLimit } from "../transaction-limits";
/** Round targets up to a basis point so the estimate covers the requested amount. */
export function percentToBps(percent: number) {
    if (!Number.isFinite(percent) || percent < 1 || percent > 100 || Math.abs(percent * 100 - Math.round(percent * 100)) > 1e-8)
        throw new Error("Percent must be 1–100 with at most two decimal places");
    return Math.round(percent * 100);
}
export function targetUSDCToBps(target: number, fullEstimate: number) {
    if (!Number.isFinite(target) || !Number.isFinite(fullEstimate) || target <= 0 || fullEstimate <= 0 || target > fullEstimate)
        throw new Error("Target must be within the position estimate");
    return Math.max(100, Math.ceil(target / fullEstimate * 10000));
}
export function estimateUSDC(bps: number, fullEstimate: number) { return fullEstimate * bps / 10000; }
export function impactFlags(bps: number) {
    if (!Number.isFinite(bps) || bps < 0)
        throw new Error("Invalid price impact");
    return { warning: bps > 200, requiresSecondConfirmation: bps > 500 };
}
export function assertImpactConfirmed(summary: {
    requiresSecondConfirmation: boolean;
}, confirmed?: boolean) {
    if (summary.requiresSecondConfirmation && confirmed !== true)
        throw new Error("Confirm the high price impact before continuing");
}
export function transactionCount(bytes: number, hasSwaps: boolean): 1 | 2 {
    if (!exceedsTxSizeLimit(bytes))
        return 1;
    if (!hasSwaps)
        throw new Error("Position withdrawal exceeds transaction size limit");
    return 2;
}
export function shouldSwap(receive: string, mint: string, outputMint: string) { return receive !== "original" && mint !== outputMint; }
/** Principal floor enforced by Raydium; fee/reward accrual is additional. */
export function principalMinimum(full: bigint, percentBps: number, slippageBps: number) {
    return full * BigInt(percentBps) * BigInt(10000 - slippageBps) / 100000000n;
}
export function capReceivedAmount(received: bigint, simulated: bigint, minimum: bigint) {
    if (received < minimum || received < 0n)
        throw new Error("Finalized withdrawal received less than minimum");
    return received < simulated ? received : simulated;
}
const usablePrice = (price: number | null | undefined): price is number => typeof price === "number" && Number.isFinite(price) && price > 0;
/**
 * The position's full USD estimate that `targetUSDCToBps` divides by. Uses the selected state's registry valuation
 * (USD per raw / 10^decimals, multiplier applied, never pair-guard corrected). 0 (target rejected) when either side
 * is unpriced or priced at 0; a per-share price is never multiplied by raw / 10^decimals directly.
 */
export function withdrawFullEstimateUsd(state: {
    currentAmounts: { a: string; b: string }; decimalsA: number; decimalsB: number;
    displayPricing?: { usdPerRawUnitA: number | null; usdPerRawUnitB: number | null };
}) {
    const a = state.displayPricing?.usdPerRawUnitA, b = state.displayPricing?.usdPerRawUnitB;
    // Same rule as add-wallet-preview's usable(): a 0 price is as unknown as a missing one. Counting it would shrink
    // the estimate, so the same target would map to more bps (withdrawing too much).
    if (!usablePrice(a) || !usablePrice(b))
        return 0;
    return Number(state.currentAmounts.a) / 10 ** state.decimalsA * a + Number(state.currentAmounts.b) / 10 ** state.decimalsB * b;
}
