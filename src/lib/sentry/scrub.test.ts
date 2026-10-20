import { describe, expect, it } from "vitest";
import { isSensitiveHeaderName, scrubSensitiveText, scrubSentryEvent } from "./scrub";

const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const signature = "1".repeat(88);

describe("scrubSensitiveText", () => {
  it("redacts RPC URLs, API keys, wallet addresses, and signatures", () => {
    const raw = `RPC https://rpc.example/sol?api_key=secret123 failed wallet=${wallet} signature ${signature} authorization=Bearer-abc`;
    const scrubbed = scrubSensitiveText(raw);
    expect(scrubbed).not.toMatch(/https?:\/\//);
    expect(scrubbed).not.toContain("secret123");
    expect(scrubbed).not.toContain(wallet);
    expect(scrubbed).not.toContain(signature);
    expect(scrubbed).toContain("[redacted-url]");
    expect(scrubbed).toContain("[redacted-address]");
    expect(scrubbed).toContain("[redacted-signature]");
  });
});

describe("sensitive request headers", () => {
  it("treats Vercel bypass, IP, and auth headers as sensitive regardless of casing", () => {
    expect(isSensitiveHeaderName("x-vercel-protection-bypass")).toBe(true);
    expect(isSensitiveHeaderName("X-Vercel-Id")).toBe(true);
    expect(isSensitiveHeaderName("X-Forwarded-For")).toBe(true);
    expect(isSensitiveHeaderName("X-Real-Ip")).toBe(true);
    expect(isSensitiveHeaderName("Forwarded")).toBe(true);
    expect(isSensitiveHeaderName("Authorization")).toBe(true);
    expect(isSensitiveHeaderName("Cookie")).toBe(true);
    expect(isSensitiveHeaderName("content-type")).toBe(false);
  });
});

describe("scrubSentryEvent", () => {
  it("scrubs exception text, drops request bodies/cookies/user, and keeps route tags", () => {
    const event = scrubSentryEvent({
      message: `boom ${wallet}`,
      exception: { values: [{ value: `Jupiter HTTP 429 from https://quotes.example/swap?api_key=leak` }] },
      tags: { route: "/api/selected-quote", error_class: "JupiterHttpError", wallet },
      extra: { token: "abc", public_message: "ok" },
      user: { ip_address: "203.0.113.9", id: wallet },
      request: {
        url: `https://sofinancelab.xyz/api/wallet?wallet=${wallet}`,
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        cookies: { session: "abc" },
        data: { signedTransaction: signature },
      },
      breadcrumbs: { values: [{ message: `sig ${signature}`, data: { apiKey: "k" } }] },
    });

    expect(event.message).toContain("[redacted-address]");
    expect(event.exception?.values?.[0]?.value).toContain("[redacted-url]");
    expect(event.exception?.values?.[0]?.value).not.toContain("leak");
    expect(event.tags).toMatchObject({ route: "/api/selected-quote", error_class: "JupiterHttpError" });
    expect(event.tags?.wallet).toBe("[redacted-address]");
    expect(event.extra?.token).toBe("[redacted]");
    expect(event.user).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.headers).toMatchObject({ authorization: "[redacted]" });
    expect(event.request?.url).toContain("[redacted-url]");
    expect(event.breadcrumbs?.values?.[0]?.message).toContain("[redacted-signature]");
    expect(event.breadcrumbs?.values?.[0]?.data?.apiKey).toBe("[redacted]");
  });

  it("strips Vercel bypass, client IP, Forwarded sig, and user.ip_address", () => {
    const event = scrubSentryEvent({
      user: { ip_address: "198.51.100.10" },
      request: {
        url: "https://sofinancelab.xyz/api/wallet",
        headers: {
          "X-Vercel-Protection-Bypass": "bypass-secret-value",
          "x-vercel-id": "sfo1::abc",
          "X-Forwarded-For": "198.51.100.10, 10.0.0.1",
          "X-Real-Ip": "198.51.100.10",
          Forwarded: "for=198.51.100.10;proto=https;sig=deadbeef",
          Authorization: "Bearer tok_live",
          Cookie: "session=abc",
          "content-type": "application/json",
        },
        env: { REMOTE_ADDR: "198.51.100.10", HTTP_X_FORWARDED_FOR: "198.51.100.10" },
      },
    });

    expect(event.user).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("bypass-secret-value");
    expect(JSON.stringify(event)).not.toContain("198.51.100.10");
    expect(JSON.stringify(event)).not.toContain("deadbeef");
    expect(JSON.stringify(event)).not.toContain("tok_live");
    expect(event.request?.headers).toMatchObject({
      "X-Vercel-Protection-Bypass": "[redacted]",
      "x-vercel-id": "[redacted]",
      "X-Forwarded-For": "[redacted]",
      "X-Real-Ip": "[redacted]",
      Forwarded: "[redacted]",
      Authorization: "[redacted]",
      Cookie: "[redacted]",
      "content-type": "application/json",
    });
    expect(event.request?.env?.REMOTE_ADDR).toBe("[redacted]");
    expect(event.request?.env?.HTTP_X_FORWARDED_FOR).toBe("[redacted]");
  });
});
