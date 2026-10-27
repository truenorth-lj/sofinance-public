// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertWithdrawHistory, isWithdrawCheckpoint, readWithdrawHistory, writeWithdrawHistory, withdrawCheckpointKey } from "./withdraw-checkpoint";
import { withdrawCheckpoint, withdrawKey, withdrawPosition, withdrawWallet } from "./test-support/withdraw-checkpoint-fixtures";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
it.each(["atomic", "withdraw", "swap"] as const)("loads full %s bytes and preserves optional and unknown fields", stage => {
 const value = withdrawCheckpoint(stage);
 Object.assign(value.prepared, { historicalExtension: { bytes: "keep-me" } });
 const summary = value.prepared.summary;
 summary.feePayer = withdrawPosition;
 summary.assets[0]!.source = withdrawWallet;
 summary.isolatedSources = [{ seed: "fixture", address: withdrawWallet, mint: summary.assets[0]!.mint, program: summary.assets[0]!.program, space: 165, rentLamports: 2039280 }];
 const raw = JSON.stringify(value, null, 2); localStorage.setItem(withdrawKey, raw);
 expect(withdrawCheckpointKey(withdrawWallet, withdrawPosition)).toBe(withdrawKey);
 const history = readWithdrawHistory(withdrawWallet, withdrawPosition);
 expect(history).toEqual({ kind: "valid", raw, checkpoint: value });
 expect(localStorage.getItem(withdrawKey)).toBe(raw);
 const next = writeWithdrawHistory(withdrawWallet, withdrawPosition, history, value);
 expect(next).toEqual({ kind: "valid", raw: JSON.stringify(value), checkpoint: value });
});
it.each([
 { percent: 50 }, { targetUSDC: 12.34 }, { percent: 1.25, receive: "original" as const },
 { percent: 100, receive: "token" as const, outputMint: withdrawPosition, confirmHighImpact: true },
])("accepts historical request form %j without defaulting/reconstructing it", input => {
 const value = withdrawCheckpoint("withdraw", { wallet: withdrawWallet, positionMint: withdrawPosition, ...input });
 const raw = JSON.stringify(value); localStorage.setItem(withdrawKey, raw);
 expect(readWithdrawHistory(withdrawWallet, withdrawPosition)).toEqual({ kind: "valid", raw, checkpoint: value });
});
it("only actual absence is missing, and malformed raw is never removed", () => {
 expect(readWithdrawHistory(withdrawWallet, withdrawPosition)).toEqual({ kind: "missing", raw: null });
 for (const raw of ["", "null", "false", "0", '""', "[]", "{}", "{invalid"]) {
  localStorage.setItem(withdrawKey, raw);
  expect(readWithdrawHistory(withdrawWallet, withdrawPosition)).toEqual({ kind: "invalid", raw });
  expect(() => writeWithdrawHistory(withdrawWallet, withdrawPosition, { kind: "missing", raw: null }, null)).toThrow(/history/);
  expect(localStorage.getItem(withdrawKey)).toBe(raw);
 }
});
it("fails closed if browser storage property itself is unavailable", () => {
 vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => { throw new Error("denied"); });
 expect(readWithdrawHistory(withdrawWallet, withdrawPosition)).toEqual({ kind: "unavailable" });
});
it("rejects newly changed valid records too, without deleting/replacing them", () => {
 const value = withdrawCheckpoint(); localStorage.setItem(withdrawKey, JSON.stringify(value));
 const history = readWithdrawHistory(withdrawWallet, withdrawPosition);
 const other = JSON.stringify(withdrawCheckpoint("swap")); localStorage.setItem(withdrawKey, other);
 expect(() => assertWithdrawHistory(withdrawWallet, withdrawPosition, history)).toThrow(/history/);
 expect(() => writeWithdrawHistory(withdrawWallet, withdrawPosition, history, null)).toThrow(/history/);
 expect(localStorage.getItem(withdrawKey)).toBe(other);
});
it("does not authenticate a structurally valid permit or claim financial verification", () => {
 const value = withdrawCheckpoint(); value.prepared.permit = "opaque-not-authenticated-here";
 expect(isWithdrawCheckpoint(value, withdrawWallet, withdrawPosition)).toBe(true);
});
it("requires first-stage recovery evidence for swap without erasing incomplete history", () => {
 const value = withdrawCheckpoint("swap");
 delete value.root;
 const raw = JSON.stringify(value); localStorage.setItem(withdrawKey, raw);
 expect(isWithdrawCheckpoint(value, withdrawWallet, withdrawPosition)).toBe(false);
 expect(readWithdrawHistory(withdrawWallet, withdrawPosition)).toEqual({ kind: "invalid", raw });
 expect(() => writeWithdrawHistory(withdrawWallet, withdrawPosition, { kind: "valid", raw, checkpoint: value }, null)).toThrow(/history/);
 expect(localStorage.getItem(withdrawKey)).toBe(raw);
});
