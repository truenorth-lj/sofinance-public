import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { clearTxInterruption, readTxInterruption, recordTxInterruption, txInterruptionMessage } from "./interrupted";

const SIG = bs58.encode(new Uint8Array(64).fill(3));
const memory = () => { const map = new Map<string, string>(); return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }; };
afterEach(() => vi.restoreAllMocks());

describe("tx interruption marker", () => {
  it("records, reads back per flow + scope, and clears", () => {
    const store = memory();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recordTxInterruption({ flow: "withdraw", scope: "p1", step: 2, of: 2, signatures: [SIG] }, store);
    expect(warn).toHaveBeenCalledWith("[tx-interrupted]", expect.stringContaining(SIG));
    expect(readTxInterruption("withdraw", "p1", store)).toMatchObject({ step: 2, of: 2, signatures: [SIG] });
    expect(readTxInterruption("withdraw", "p2", store)).toBeNull();
    expect(readTxInterruption("open", "p1", store)).toBeNull();
    clearTxInterruption("withdraw", "p1", store);
    expect(readTxInterruption("withdraw", "p1", store)).toBeNull();
  });
  it("ignores a tampered record", () => {
    const store = memory();
    store.setItem("sofinance:tx-interrupted:withdraw:p1", JSON.stringify({ flow: "withdraw", scope: "p1", step: 2, signatures: ["<script>"] }));
    expect(readTxInterruption("withdraw", "p1", store)).toBeNull();
  });
  it("says which steps were sent and which was not", () => {
    expect(txInterruptionMessage({ step: 2, of: 2, signatures: [SIG] })).toBe(
      "An earlier run stopped part-way: step 1 of 2 was sent to Solana, but step 2 of 2 was never sent. Check the steps on Solscan and the position, then run it again to finish.");
  });
});
