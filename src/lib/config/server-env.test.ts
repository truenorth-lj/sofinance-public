import { afterEach, describe, expect, it, vi } from "vitest";
import { getJupiterApiKey, getSigningSecret } from "@sofinance/engine/config/server-env";

// The reference expressions are what every call site contained before the refactor.
const legacyRaw = () => process.env.JUPITER_API_KEY;
const legacyOrEmpty = () => process.env.JUPITER_API_KEY || "";

const STATES: [string, string | undefined][] = [
  ["unset", undefined], ["empty", ""], ["single space", " "], ["padded key", "  abc  "], ["newline", "abc\n"], ["plain key", "abc123"],
];

describe("server-env equivalence with the previous inline reads", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(STATES)("%s: getJupiterApiKey() === process.env.JUPITER_API_KEY", (_name, value) => {
    vi.stubEnv("JUPITER_API_KEY", value);
    expect(getJupiterApiKey()).toBe(legacyRaw());
  });

  it.each(STATES)("%s: getSigningSecret() === process.env.JUPITER_API_KEY || ''", (_name, value) => {
    vi.stubEnv("JUPITER_API_KEY", value);
    expect(getSigningSecret()).toBe(legacyOrEmpty());
  });

  it("pins the concrete values (nothing is trimmed, empty is falsy but passes through the raw getter)", () => {
    vi.stubEnv("JUPITER_API_KEY", undefined);
    expect([getJupiterApiKey(), getSigningSecret()]).toEqual([undefined, ""]);
    vi.stubEnv("JUPITER_API_KEY", "");
    expect([getJupiterApiKey(), getSigningSecret()]).toEqual(["", ""]);
    vi.stubEnv("JUPITER_API_KEY", "  abc  ");
    expect([getJupiterApiKey(), getSigningSecret()]).toEqual(["  abc  ", "  abc  "]);
  });

  it("is read on every call (not cached at import time)", () => {
    vi.stubEnv("JUPITER_API_KEY", "first");
    expect(getSigningSecret()).toBe("first");
    vi.stubEnv("JUPITER_API_KEY", "rotated");
    expect(getSigningSecret()).toBe("rotated");
    expect(getJupiterApiKey()).toBe("rotated");
  });

  it("does not read any other variable", () => {
    vi.stubEnv("JUPITER_API_KEY", undefined);
    vi.stubEnv("SOLANA_RPC_URL", "https://other.example");
    vi.stubEnv("SOFINANCE_SIGNING_SECRET", "other");
    expect(getSigningSecret()).toBe("");
    expect(getJupiterApiKey()).toBeUndefined();
  });
});
