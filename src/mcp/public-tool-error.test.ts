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

  it("QUIRK (shared sanitizer, also on web routes): 'authorization: Bearer <token>' only redacts the word after the separator", () => {
    expect(publicToolError(new Error("authorization: Bearer SECRET456"))).toBe("[redacted] SECRET456");
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
