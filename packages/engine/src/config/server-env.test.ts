import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getJupiterApiKey, getSigningSecret, getSigningSecrets } from "./server-env";

// The reference expressions are what every call site contained before the refactor.
const legacyRaw = () => process.env.JUPITER_API_KEY;
const legacyOrEmpty = () => process.env.JUPITER_API_KEY || "";

const STATES: [string, string | undefined][] = [
  ["unset", undefined], ["empty", ""], ["single space", " "], ["padded key", "  abc  "], ["newline", "abc\n"], ["plain key", "abc123"],
];

describe("server-env", () => {
  beforeEach(() => {
    vi.stubEnv("SOFINANCE_SIGNING_SECRET", undefined);
    vi.stubEnv("SOFINANCE_SIGNING_SECRET_PREVIOUS", undefined);
  });
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

  it("uses the dedicated signing key when configured and rereads it on rotation", () => {
    vi.stubEnv("JUPITER_API_KEY", "jupiter");
    vi.stubEnv("SOFINANCE_SIGNING_SECRET", "  current  ");
    vi.stubEnv("SOFINANCE_SIGNING_SECRET_PREVIOUS", "previous");
    expect(getSigningSecret()).toBe("  current  ");
    expect(getSigningSecrets()).toEqual(["  current  ", "previous"]);
    expect(getJupiterApiKey()).toBe("jupiter");

    vi.stubEnv("SOFINANCE_SIGNING_SECRET", "previous");
    expect(getSigningSecrets()).toEqual(["previous"]);

    vi.stubEnv("SOFINANCE_SIGNING_SECRET", "");
    vi.stubEnv("SOFINANCE_SIGNING_SECRET_PREVIOUS", "");
    expect(getSigningSecrets()).toEqual(["jupiter"]);
  });

  it("never uses the previous secret for issuance or as the only verification key", () => {
    vi.stubEnv("JUPITER_API_KEY", undefined);
    vi.stubEnv("SOFINANCE_SIGNING_SECRET_PREVIOUS", "previous");
    expect(getSigningSecret()).toBe("");
    expect(getSigningSecrets()).toEqual([""]);
    expect(getJupiterApiKey()).toBeUndefined();

    vi.stubEnv("SOFINANCE_SIGNING_SECRET", "current");
    expect(getSigningSecrets()).toEqual(["current", "previous"]);
    expect(getJupiterApiKey()).toBeUndefined();
  });
});
