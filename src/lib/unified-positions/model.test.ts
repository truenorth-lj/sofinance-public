import { describe, expect, it } from "vitest";
import { isToolSupported, NOT_AVAILABLE_MESSAGE, parsePositionKey, positionKey, SUPPORTED, toolUnavailableReason, unsupported, type SourceCapabilities } from "./model";

const caps = (over: Partial<SourceCapabilities> = {}): SourceCapabilities => ({
  compound: SUPPORTED, performance: SUPPORTED, deposit: SUPPORTED, withdraw: { supported: true, partial: true }, withdrawOutputs: ["pool-tokens"],
  exitPreview: SUPPORTED, rangeDisplay: "price", manualAdd: false, signer: "solana-wallet", ...over,
});

describe("position keys", () => {
  it("round-trips source:nativeId", () => {
    const key = positionKey("rhc-uniswap-v4", "1234");
    expect(key).toBe("rhc-uniswap-v4:1234");
    expect(parsePositionKey(key)).toEqual({ source: "rhc-uniswap-v4", nativeId: "1234" });
    expect(parsePositionKey("raydium-clmm:AbC:x")).toEqual({ source: "raydium-clmm", nativeId: "AbC:x" });
  });
  it("rejects unknown sources and empty parts", () => {
    for (const bad of ["", null, undefined, "nope:1", "raydium-clmm:", ":abc", "raydium-clmm"]) expect(parsePositionKey(bad)).toBeNull();
  });
});

describe("capabilities", () => {
  it("reports support and the reason", () => {
    const c = caps({ compound: unsupported(NOT_AVAILABLE_MESSAGE) });
    expect(isToolSupported(c, "compound")).toBe(false);
    expect(toolUnavailableReason(c, "compound")).toBe("Not available for this pool yet");
    expect(toolUnavailableReason(c, "deposit")).toBeNull();
    expect(isToolSupported(caps({ withdraw: { supported: false, reason: "x" } }), "withdraw")).toBe(false);
  });
});
