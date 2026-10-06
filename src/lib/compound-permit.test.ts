import { describe, expect, it } from "vitest";
import { issueCompoundPermit, verifyCompoundPermit } from "./compound-permit";

describe("compound authorization", () => {
  const input = { wallet: "wallet", message: "message", summary: {
    operation: "compound", liquidity: "10", expiresAt: 500,
    compoundAccounts: [{ seed: "fresh", address: "yield", mint: "A" }],
  } };
  it("binds source isolation, liquidity, wallet, operation and signed message", () => {
    const permit = issueCompoundPermit("test-secret", input);
    expect(verifyCompoundPermit("test-secret", input, permit)).toBe(true);
    for (const changed of [
      { ...input, wallet: "other" }, { ...input, message: "modified-message" },
      { ...input, summary: { ...input.summary, operation: "recovery" } },
      { ...input, summary: { ...input.summary, liquidity: "11" } },
      { ...input, summary: { ...input.summary, compoundAccounts: [{ seed: "fresh", address: "wallet-ata", mint: "A" }] } },
    ]) expect(verifyCompoundPermit("test-secret", changed, permit)).toBe(false);
    expect(verifyCompoundPermit("test-secret", input, null)).toBe(false);
  });
  it("survives JSON key reordering but rejects a different signing secret", () => {
    const permit = issueCompoundPermit("test-secret", input);
    const reordered = { summary: { expiresAt: 500, compoundAccounts: input.summary.compoundAccounts,
      liquidity: "10", operation: "compound" }, message: input.message, wallet: input.wallet };
    expect(verifyCompoundPermit("test-secret", reordered, permit)).toBe(true);
    expect(verifyCompoundPermit("other-secret", input, permit)).toBe(false);
  });
});
