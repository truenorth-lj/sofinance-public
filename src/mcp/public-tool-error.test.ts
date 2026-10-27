import { describe, expect, it } from "vitest";
import { z } from "zod";
import { publicToolError } from "./public-tool-error";

describe("publicToolError", () => {
  it("redacts URLs and credential-looking pairs", () => {
    const text = publicToolError(new Error("failed https://rpc.example/x?api_key=SECRET123 and api-key=SECRET789"));
    expect(text).not.toMatch(/SECRET|rpc\.example/);
    expect(text).toContain("[redacted]");
  });

  it("handles non-Error values", () => {
    expect(publicToolError("plain string failure")).toBe("plain string failure");
    expect(publicToolError(null)).toBe("null");
    for (const weird of [undefined, () => 1]) expect(publicToolError(weird, "fallback text")).toBe("fallback text");
    expect(publicToolError("", "fallback text")).toBe("fallback text");
  });

  it("redacts both the authorization scheme and its credential", () => {
    expect(publicToolError(new Error("authorization: Bearer SECRET456"))).toBe("[redacted]");
  });

  it.each([
    "Bearer R2_KEY_7", "Basic R2_KEY_7+TAIL==", "access_token=R2_KEY_7", "refresh_token=R2_KEY_7",
    "client_secret=R2_KEY_7", "JUPITER_API_KEY=R2_KEY_7", "X-Auth-Token: R2_KEY_7",
    JSON.stringify({ error: JSON.stringify({ "api-key": "R2_KEY_7" }) }),
    JSON.stringify({ error: JSON.stringify({ authorization: "Bearer R2_KEY_7" }) }),
  ])("scrubs R2 diagnostic %s, including transactionError", (diagnostic) => {
    for (const error of [new Error(diagnostic), Object.assign(new Error("provider failed"), {
      transactionError: { message: diagnostic },
    })]) {
      const result = publicToolError(error);
      expect(result).not.toContain("R2_KEY_7");
      expect(result).not.toContain("TAIL");
      expect(result).toContain("[redacted]");
    }
    expect(publicToolError(new Error(""), diagnostic)).not.toContain("R2_KEY_7");
  });

  it("retains public wallet and ordinary diagnostic wording", () => {
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const text = `Token program failed: design=retry; mytoken=missing; tokenizer=ready; wallet=${wallet}`;
    expect(publicToolError(new Error(text))).toBe(text);
  });

  it("flattens zod errors into 'path: message' and marks missing fields as required", () => {
    const schema = z.object({ wallet: z.string(), nested: z.object({ n: z.number().min(5) }) });
    const result = schema.safeParse({ nested: { n: 1 } });
    if (result.success) throw new Error("expected failure");
    const text = publicToolError(result.error);
    expect(text).toMatch(/^Invalid arguments: wallet: required; nested\.n: /);
    expect(text).not.toContain("\n");
  });

  it("redacts a URL echoed inside a zod message", () => {
    const schema = z.string().refine(() => false, "bad value https://x.example/?token=SECRET123");
    const result = schema.safeParse("a");
    if (result.success) throw new Error("expected failure");
    expect(publicToolError(result.error)).not.toMatch(/SECRET123|x\.example/);
  });
});
