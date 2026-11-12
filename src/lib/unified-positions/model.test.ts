import { describe, expect, it } from "vitest";
import { isToolSupported, NOT_AVAILABLE_MESSAGE, parsePositionKey, positionKey, positionKeysEqual, SUPPORTED, toolUnavailableReason, unsupported, type SourceCapabilities } from "./model";

const caps = (over: Partial<SourceCapabilities> = {}): SourceCapabilities => ({
  compound: SUPPORTED, performance: SUPPORTED, deposit: SUPPORTED, withdraw: { supported: true, partial: true }, withdrawOutputs: ["pool-tokens"],
  exitPreview: SUPPORTED, rangeDisplay: "price", manualAdd: false, signer: "solana-wallet", ...over,
});

describe("position keys", () => {
  it("round-trips source:nativeId and writes the canonical RHC spelling", () => {
    const key = positionKey("uniswap-v4-rhc", "1234");
    expect(key).toBe("uniswap-v4-rhc:1234");
    expect(parsePositionKey(key)).toEqual({ source: "uniswap-v4-rhc", nativeId: "1234" });
    expect(parsePositionKey("raydium-clmm:AbC:x")).toEqual({ source: "raydium-clmm", nativeId: "AbC:x" });
  });
  it("does not treat the retired rhc-uniswap-v4 spelling as a position key", () => {
    expect(parsePositionKey("rhc-uniswap-v4:4077059")).toBeNull();
    expect(parsePositionKey("uniswap-v4-rhc:4077059")).toEqual({ source: "uniswap-v4-rhc", nativeId: "4077059" });
    expect(positionKeysEqual("rhc-uniswap-v4:4077059", "uniswap-v4-rhc:4077059")).toBe(false);
  });
  it("rejects unknown sources and empty parts", () => {
    for (const bad of ["", null, undefined, "nope:1", "raydium-clmm:", ":abc", "raydium-clmm", "rhc-uniswap-v4:1"]) expect(parsePositionKey(bad)).toBeNull();
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
