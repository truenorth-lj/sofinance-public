import { describe, expect, it } from "vitest";
import { createPermit } from "./permit";

describe("createPermit(domain)", () => {
  const input = { wallet: "W", message: "m", summary: { a: 1, b: [2, { c: undefined, d: null }] } };

  it("issues deterministic 64-hex permits that verify", () => {
    const permit = createPermit("test:domain:v1");
    const value = permit.issue("secret", input);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(permit.issue("secret", input)).toBe(value);
    expect(permit.verify("secret", input, value)).toBe(true);
  });

  it("is isolated by domain, secret, and every input field", () => {
    const a = createPermit("test:a:v1");
    const b = createPermit("test:b:v1");
    const value = a.issue("secret", input);
    expect(b.verify("secret", input, value)).toBe(false);
    expect(a.verify("other", input, value)).toBe(false);
    expect(a.verify("secret", { ...input, wallet: "X" }, value)).toBe(false);
    expect(a.verify("secret", { ...input, message: "x" }, value)).toBe(false);
    expect(a.verify("secret", { ...input, summary: { a: 2 } }, value)).toBe(false);
  });

  it("matches the documented payload: HMAC-SHA256 over `${domain}:${canonical json}` (keys sorted, undefined dropped)", async () => {
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", "secret")
      .update('test:d:v1:{"message":"m","summary":{"a":1,"b":[2,{"d":null}]},"wallet":"W"}').digest("hex");
    expect(createPermit("test:d:v1").issue("secret", input)).toBe(expected);
  });

  it("rejects an empty secret and malformed permits", () => {
    const permit = createPermit("test:domain:v1");
    expect(() => permit.issue("", input)).toThrow("Missing server signing key");
    for (const bad of [undefined, null, 1, "", "zz", "A".repeat(64)]) expect(permit.verify("secret", input, bad)).toBe(false);
  });
});
