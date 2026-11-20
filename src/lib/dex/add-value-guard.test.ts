import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ADD_VALUE_FLOOR_BPS, ADD_VALUE_UNPRICED_MESSAGE, ADD_VALUE_UNPRICED_NARROW_MESSAGE, ADD_VALUE_TOO_LOW_CODE, ADD_VALUE_UNPRICED_CODE, AddValueBlockedError, addValueTooLowMessage, assessAddValue } from "./add-value-guard";
import { dexDescriptors } from "./client";
import { publicErrorCode, sanitizePublicError } from "../public-error";

const token = (units: number, usd: number | null = 1) => ({ raw: BigInt(Math.round(units * 1e6)), decimals: 6, usd });
const check = (deposit: number, buffer = 0, narrowRange = false) => assessAddValue({
  floorBps: ADD_VALUE_FLOOR_BPS, input: token(400), deposit: [token(deposit)], buffer: [token(buffer)], narrowRange,
});

describe("Add market-value floor", () => {
  it("opts in through the descriptor registry with the one 97% constant", () => {
    expect(ADD_VALUE_FLOOR_BPS).toBe(9_700);
    expect(dexDescriptors.descriptorFor("raydium-clmm")?.meta.addValueFloorBps).toBe(ADD_VALUE_FLOOR_BPS);
  });
  it("counts the leftover buffer, not just the position deposit; accepts exactly the floor", () => {
    expect(check(384, 4)).toEqual({ kind: "ok", inputUsd: 400, deliveredUsd: 388 });
    expect(check(383.99, 4)).toMatchObject({ kind: "too-low" });
  });
  it("blocks a truly bad swap even if the route reports a small price impact", () => {
    expect(check(6, 0.4)).toMatchObject({ kind: "too-low", inputUsd: 400, depositUsd: 6, bufferUsd: 0.4 });
    // Fairly priced deposit from the incident's $400 add, including its 1% wallet reserve.
    expect(check(392, 4, true).kind).toBe("ok");
  });
  it("handles 8-decimal and 6-decimal stock tokens without mixing raw units", () => {
    const result = assessAddValue({ floorBps: ADD_VALUE_FLOOR_BPS, narrowRange: true, input: token(400),
      deposit: [{ raw: 338500347n, decimals: 8, usd: 57.95 }, { raw: 3384921n, decimals: 6, usd: 57.95 }],
      buffer: [{ raw: 3385003n, decimals: 8, usd: 57.95 }, { raw: 46181n, decimals: 6, usd: 57.95 }],
    });
    expect(result.kind).toBe("ok");
  });
  it("fails closed on missing/invalid prices; a one-step range says why it cannot skip the check", () => {
    for (const price of [null, 0, NaN, Infinity]) {
      for (const narrowRange of [true, false]) {
        expect(assessAddValue({ floorBps: ADD_VALUE_FLOOR_BPS, narrowRange,
          input: token(400), deposit: [token(392, price)], buffer: [token(4)],
        })).toEqual({ kind: "unpriced", message: narrowRange ? ADD_VALUE_UNPRICED_NARROW_MESSAGE : ADD_VALUE_UNPRICED_MESSAGE });
      }
    }
  });
  it("does not require a price for a side with zero deposit and zero buffer", () => {
    expect(assessAddValue({ floorBps: ADD_VALUE_FLOOR_BPS, narrowRange: true, input: token(400),
      deposit: [token(392), token(0, null)], buffer: [token(4), token(0, null)],
    }).kind).toBe("ok");
  });
  it("has plain, complete copy, no banned words/codes and never calls a guard block a cancellation", () => {
    const messages = [addValueTooLowMessage({ inputUsd: 400, depositUsd: 6, bufferUsd: 0.4 }), ADD_VALUE_UNPRICED_MESSAGE, ADD_VALUE_UNPRICED_NARROW_MESSAGE];
    for (const message of messages) {
      expect(message).not.toMatch(/backtest|\bearn\b|\byield\b|auto-rebalance|guarantee|cancel(?:led|ed)|https?:|\b\d{4,}\b|add_value_/i);
      expect(message).toMatch(/Nothing was sent/);
      expect(message).toMatch(/Try /);
      expect(sanitizePublicError(new AddValueBlockedError("too-low", message), "Add failed")).toBe(message);
    }
    expect(publicErrorCode(new AddValueBlockedError("too-low", messages[0]!))).toBe(ADD_VALUE_TOO_LOW_CODE);
    expect(publicErrorCode(new AddValueBlockedError("unpriced", ADD_VALUE_UNPRICED_MESSAGE))).toBe(ADD_VALUE_UNPRICED_CODE);
    expect(ADD_VALUE_UNPRICED_CODE).not.toBe(ADD_VALUE_TOO_LOW_CODE);
    expect(messages[0]).toBe("Only about $6.00 of your $400 would go into this position (plus about $0.40 left in your wallet), because the swap price for this amount is too far from the market price. Nothing was sent. Try a smaller amount.");
  });
});
