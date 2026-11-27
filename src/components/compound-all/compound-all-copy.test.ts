import { describe, expect, it } from "vitest";
import { rowResultUnconfirmed, rowStatusLabel } from "./compound-all-copy";

describe("row flags, not message text, decide unconfirmed and Couldn't send", () => {
  it("rowResultUnconfirmed is only a failed, non-retryable row with outcomeUnconfirmed", () => {
    expect(rowResultUnconfirmed({ status: "failed", retryable: false, outcomeUnconfirmed: true })).toBe(true);
    expect(rowResultUnconfirmed({ status: "failed", retryable: false, outcomeUnconfirmed: false })).toBe(false);
    expect(rowResultUnconfirmed({ status: "failed", retryable: false })).toBe(false);
    expect(rowResultUnconfirmed({ status: "failed", retryable: true, outcomeUnconfirmed: true })).toBe(false);
    // A message that looks unconfirmed does not matter once the flag is absent.
    expect(rowResultUnconfirmed({ status: "failed", retryable: false, error: "This compound is still confirming." } as never)).toBe(false);
  });
  it("Couldn't send is only the couldntSend flag; a still-confirming row stays Failed", () => {
    expect(rowStatusLabel({ status: "failed", selected: true, couldntSend: true })).toBe("Couldn't send");
    expect(rowStatusLabel({ status: "failed", selected: true, couldntSend: false })).toBe("Failed");
    expect(rowStatusLabel({ status: "failed", selected: true })).toBe("Failed");
  });
});
