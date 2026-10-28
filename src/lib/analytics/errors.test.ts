import { describe, expect, it } from "vitest";
import { classifyOpenError } from "./errors";

describe("open error classes", () => {
  it("maps known failures to a coarse class and never echoes the raw text", () => {
    const wallet = "So11111111111111111111111111111111111111112";
    expect(classifyOpenError("User rejected the request")).toBe("user_rejected");
    expect(classifyOpenError(new Error("Transaction blockhash expired"))).toBe("expired");
    expect(classifyOpenError(`Transaction simulation failed for ${wallet}`)).toBe("simulation_failed");
    expect(classifyOpenError("Permit mismatch")).toBe("authorization");
    expect(classifyOpenError("Wallet removed or changed a required instruction (unmatched #0 program=alt)")).toBe("authorization");
    expect(classifyOpenError("socket hang up")).toBe("network");
    expect(classifyOpenError("Open-position transaction failed on-chain")).toBe("onchain_failed");
    expect(classifyOpenError(`secret key ${wallet} leaked`)).toBe("unknown");
    expect(classifyOpenError(`secret key ${wallet} leaked`)).not.toContain(wallet);
  });
});
