// The cross-op lock per position (PM review of #289): any op in flight or confirming on a position blocks every other
// op on that position; other positions are free; a settled or dismissed notice releases it.
import { afterEach, describe, expect, it } from "vitest";
import { dismissTxNotice, holdCancelCheck, cancelCheckKey, noticeIdFor, resetCancelChecks, resetTxNotices, settleTxNotice, trackTxSignature } from "@/lib/tx-pipeline";
import { beginPositionOp, isPositionCancelPending, isPositionOpBusy, resetPositionOpLocks, trackPositionSignature } from "./position-op-lock";
import { compoundBlockedReason, compoundRangeLine, feeLine, tokenAccountRentLine } from "./registry-tools";
import type { UnifiedPosition } from "@/lib/unified-positions/model";

const KEY = "meteora-dlmm:pos1";
const OTHER = "meteora-dlmm:pos2";
const SIG = "5".repeat(88);
afterEach(() => { resetPositionOpLocks(); resetTxNotices(); resetCancelChecks(); });

describe("position op lock", () => {
  it("one send at a time per position, across ops; other positions are free", () => {
    const release = beginPositionOp(KEY)!;
    expect(release).toBeTypeOf("function");
    expect(isPositionOpBusy(KEY)).toBe(true);
    expect(beginPositionOp(KEY)).toBeNull();
    const other = beginPositionOp(OTHER);
    expect(other).not.toBeNull();
    release();
    release(); // idempotent
    expect(isPositionOpBusy(KEY)).toBe(false);
    expect(beginPositionOp(KEY)).not.toBeNull();
  });

  it("stays locked while a sent signature is confirming, and frees when it settles or its notice is dismissed", () => {
    trackTxSignature({ flow: "claim", signature: SIG, lastValidBlockHeight: 5, wallet: "w", successTitle: "Fees claimed" });
    trackPositionSignature(KEY, SIG);
    expect(isPositionOpBusy(KEY)).toBe(true);
    expect(beginPositionOp(KEY)).toBeNull();
    settleTxNotice(noticeIdFor(SIG), "confirmed");
    expect(isPositionOpBusy(KEY)).toBe(false);
    trackTxSignature({ flow: "claim", signature: SIG, lastValidBlockHeight: 5, wallet: "w", successTitle: "Fees claimed" });
    trackPositionSignature(KEY, SIG);
    dismissTxNotice(noticeIdFor(SIG));
    expect(isPositionOpBusy(KEY)).toBe(false);
  });

  it("a cancelled send of any op on the position that is still being checked blocks the others", async () => {
    let done!: () => void;
    holdCancelCheck(cancelCheckKey("claim", KEY), new Promise<void>((resolve) => { done = resolve; }));
    expect(isPositionCancelPending(KEY)).toBe(true);
    expect(beginPositionOp(KEY)).toBeNull();
    expect(isPositionCancelPending(OTHER)).toBe(false);
    done();
    await Promise.resolve(); await Promise.resolve();
    expect(isPositionCancelPending(KEY)).toBe(false);
  });
});

const position = (rangeStatus: UnifiedPosition["rangeStatus"], fees: { a: string; b: string } | null) => ({
  key: KEY, source: "meteora-dlmm", chain: "solana", nativeId: "pos1", poolId: "pool", rangeStatus, liquidity: "1", valueUsd: null,
  tokenA: { id: "mintA", symbol: "SPCX", decimals: 6 }, tokenB: { id: "mintB", symbol: "SPCXx", decimals: 8 },
  range: { mode: "price", lower: 1, upper: 2, current: 1.5 },
  ...(fees ? { holdings: { liquidityRaw: { a: "1", b: "1" }, unclaimedFeesRaw: fees } } : {}), native: {},
}) as unknown as UnifiedPosition;
const symbol = (token: { symbol: string | null }) => token.symbol ?? "?";

describe("compound copy", () => {
  it("out of range names the tokens: price above the range keeps the B side", () => {
    expect(compoundRangeLine(position("above", null), symbol)).toBe("The price is outside this position's range. Only SPCXx fees go back into the position; SPCX fees go to your wallet.");
    expect(compoundRangeLine(position("in", null), symbol)).toBeNull();
  });
  it("blocked only when nothing can go back in; unread fees never block (the server still checks)", () => {
    expect(compoundBlockedReason(position("in", { a: "0", b: "0" }), symbol)).toBe("This position has no unclaimed fees yet, so there is nothing to compound.");
    expect(compoundBlockedReason(position("above", { a: "12", b: "0" }), symbol)).toBe("There are no SPCXx fees to put back while the price is outside the range. Claim the SPCX fees to your wallet instead.");
    expect(compoundBlockedReason(position("above", { a: "0", b: "3" }), symbol)).toBeNull();
    expect(compoundBlockedReason(position("in", { a: "1", b: "0" }), symbol)).toBeNull();
    expect(compoundBlockedReason(position("in", null), symbol)).toBeNull();
  });
  it("states the rent of token accounts the step creates, exact from the prepared step", () => {
    expect(tokenAccountRentLine(undefined, () => "x")).toBeNull();
    expect(tokenAccountRentLine([{ mint: "mintB", rentLamports: "2039280" }], (mint) => mint === "mintB" ? "SPCXx" : "?"))
      .toBe("This also creates your SPCXx token account in your wallet: about 0.0020 SOL rent, which comes back if you close that account.");
    expect(tokenAccountRentLine([{ mint: "a", rentLamports: "2039280" }, { mint: "b", rentLamports: "2074080" }], (mint) => mint.toUpperCase()))
      .toBe("This also creates your A and B token accounts in your wallet: about 0.0041 SOL rent, which comes back if you close them.");
  });
  it("a fee line with no noun has no stray space", () => {
    expect(feeLine({ kind: "swap-input-bps", bps: 10 }, "")).toBe("A 0.1% platform fee applies only to the part we swap; nothing is charged on the rest.");
  });
});
