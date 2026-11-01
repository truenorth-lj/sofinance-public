import { describe, expect, it } from "vitest";
import { directUsdcExitPreview, holdsUsdcDirectly } from "./exit-preview-support";
import { USDC_MINT } from "./ids";

describe("exit preview direct-USDC support", () => {
  it("flags a pool or reward mint that is USDC", () => {
    expect(holdsUsdcDirectly([USDC_MINT, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"])).toBe(true);
    expect(holdsUsdcDirectly(["So11111111111111111111111111111111111111112", undefined, null])).toBe(false);
  });
  it("is a typed read-only result, not an error", () => {
    expect(directUsdcExitPreview()).toMatchObject({ status: "unsupported", reason: "direct_usdc", executable: false, sent: false, netRecoveryUSDC: null });
    expect(directUsdcExitPreview().message).toMatch(/aren't available yet for pools that hold USDC directly/);
  });
});
