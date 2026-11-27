import { describe, expect, it } from "vitest";
import { cleanupStatusLabel, rowResultUnconfirmed, rowStatusLabel, summaryItems } from "./compound-all-copy";
import { createCompoundAllState, compoundAllReducer, type CompoundAllRowInput } from "@/lib/compound-all/state";

describe("row flags, not message text, decide unconfirmed and Couldn't send", () => {
  it("rowResultUnconfirmed is only a failed, non-retryable row with outcomeUnconfirmed", () => {
    expect(rowResultUnconfirmed({ status: "failed", retryable: false, outcomeUnconfirmed: true })).toBe(true);
    expect(rowResultUnconfirmed({ status: "failed", retryable: false, outcomeUnconfirmed: false })).toBe(false);
    expect(rowResultUnconfirmed({ status: "failed", retryable: false })).toBe(false);
    expect(rowResultUnconfirmed({ status: "failed", retryable: true, outcomeUnconfirmed: true })).toBe(false);
    // A message that looks unconfirmed does not matter once the flag is absent.
    expect(rowResultUnconfirmed({ status: "failed", retryable: false, error: "This compound is still confirming." } as never)).toBe(false);
  });
  it("Couldn't send stays Couldn't send; outcomeUnconfirmed without that flag is Unconfirmed, not Failed", () => {
    expect(rowStatusLabel({ status: "failed", selected: true, couldntSend: true })).toBe("Couldn't send");
    expect(rowStatusLabel({ status: "failed", selected: true, couldntSend: true, outcomeUnconfirmed: true })).toBe("Couldn't send");
    expect(rowStatusLabel({ status: "failed", selected: true, couldntSend: false, outcomeUnconfirmed: true })).toBe("Unconfirmed");
    expect(rowStatusLabel({ status: "failed", selected: true, outcomeUnconfirmed: true })).toBe("Unconfirmed");
    expect(rowStatusLabel({ status: "failed", selected: true, couldntSend: false })).toBe("Failed");
    expect(rowStatusLabel({ status: "failed", selected: true })).toBe("Failed");
  });
});

describe("cleanup and summary labels", () => {
  it("labels a confirming cleanup Confirming… and a finished cleanup Done", () => {
    expect(cleanupStatusLabel("confirming")).toBe("Confirming…");
    expect(cleanupStatusLabel("done")).toBe("Done");
    expect(cleanupStatusLabel("failed")).toBe("Failed");
    expect(cleanupStatusLabel("failed", true)).toBe("Unconfirmed");
  });
  it("does not count unconfirmed rows as Did not complete", () => {
    const input: CompoundAllRowInput = { key: "meteora-dlmm:m1" as CompoundAllRowInput["key"], dex: "meteora-dlmm", flow: "registry", positionId: "m1" };
    let state = createCompoundAllState([input]);
    state = compoundAllReducer(state, { type: "start" });
    state = compoundAllReducer(state, { type: "row/stage", key: input.key, stage: "preparing" });
    state = compoundAllReducer(state, { type: "row/failed", key: input.key, failure: "failed", error: "still confirming", retryable: false, outcomeUnconfirmed: true });
    expect(summaryItems(state)).toEqual([
      ["Compounded", 0], ["Skipped", 0], ["Not signed", 0], ["Unconfirmed", 1], ["Did not complete", 0],
    ]);
  });
});
