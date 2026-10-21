import { describe, expect, it } from "vitest";
import {
  isSensitiveHeaderName,
  isSensitiveIpEnvKey,
  minimalSentryEvent,
  scrubBreadcrumb,
  scrubSensitiveText,
  scrubSentryEvent,
  scrubUnknown,
} from "./scrub";

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

  it("passes non-strings through and recurses into arrays/objects", () => {
    expect(scrubSensitiveText(undefined)).toBeUndefined();
    expect(scrubSensitiveText(null)).toBeNull();
    expect(scrubSensitiveText(42)).toBe(42);
    expect(scrubSensitiveText(true)).toBe(true);
    const leftover = { keep: true };
    expect(scrubSensitiveText(leftover)).not.toBe(leftover);
    expect(scrubSensitiveText(["https://rpc.example/sol", 7, { token: "abc" }])).toEqual([
      "[redacted-url]",
      7,
      { token: "[redacted]" },
    ]);
    expect(scrubSensitiveText({ rpc: "https://rpc.example/sol", count: 3 })).toEqual({
      rpc: "[redacted-url]",
      count: 3,
    });
  });

  it("redacts URL-encoded RPC URLs and secrets in query strings", () => {
    const encoded = "rpc=https%3A%2F%2Frpc.example.com%2Fsol%3Fapi_key%3Dsecret123";
    const scrubbed = scrubSensitiveText(encoded);
    expect(scrubbed).not.toContain("rpc.example.com");
    expect(scrubbed).not.toContain("secret123");
    expect(scrubbed).not.toMatch(/https?:\/\//i);
    expect(scrubbed).not.toMatch(/https?%3A%2F%2F/i);
    expect(scrubbed).toContain("[redacted-url]");
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
    expect(isSensitiveHeaderName(undefined)).toBe(false);
    expect(isSensitiveHeaderName(12)).toBe(false);
    expect(isSensitiveHeaderName(["authorization"])).toBe(false);
  });
});

describe("isSensitiveIpEnvKey", () => {
  it("matches whole IP/forwarded key segments, not description or zip", () => {
    expect(isSensitiveIpEnvKey("ip")).toBe(true);
    expect(isSensitiveIpEnvKey("IP")).toBe(true);
    expect(isSensitiveIpEnvKey("client_ip")).toBe(true);
    expect(isSensitiveIpEnvKey("ip_address")).toBe(true);
    expect(isSensitiveIpEnvKey("x-real-ip")).toBe(true);
    expect(isSensitiveIpEnvKey("remote_addr")).toBe(true);
    expect(isSensitiveIpEnvKey("REMOTE_ADDR")).toBe(true);
    expect(isSensitiveIpEnvKey("x-forwarded-for")).toBe(true);
    expect(isSensitiveIpEnvKey("HTTP_X_FORWARDED_FOR")).toBe(true);
    expect(isSensitiveIpEnvKey("forwarded")).toBe(true);
    expect(isSensitiveIpEnvKey("description")).toBe(false);
    expect(isSensitiveIpEnvKey("zip")).toBe(false);
    expect(isSensitiveIpEnvKey("public_message")).toBe(false);
    expect(isSensitiveIpEnvKey(undefined)).toBe(false);
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

  it("handles non-string header values, array headers, and env objects without throwing", () => {
    const event = scrubSentryEvent({
      request: {
        url: "https://sofinancelab.xyz/api/pool-range-apr?rpc=https%3A%2F%2Frpc.example.com",
        headers: {
          "content-type": "application/json",
          "x-request-id": 42,
          "x-flag": true,
          "x-empty": null,
          "x-forwarded-for": ["198.51.100.10", "10.0.0.1"],
          "accept": ["application/json", "text/plain"],
          "x-rpc": ["https://rpc.example.com", 9],
        },
        query_string: "rpc=https%3A%2F%2Frpc.example.com%2Fsol%3Fapi_key%3Dsecret123",
        env: {
          NODE_ENV: "production",
          REMOTE_ADDR: "198.51.100.10",
          RPC_URL: "https://rpc.example.com",
          WORKER_ID: 7,
          NESTED: { authorization: "Bearer tok", count: 1 },
        },
      },
    });

    expect(event.request?.headers).toMatchObject({
      "content-type": "application/json",
      "x-request-id": 42,
      "x-flag": true,
      "x-empty": null,
      "x-forwarded-for": ["[redacted]", "[redacted]"],
      accept: ["application/json", "text/plain"],
      "x-rpc": ["[redacted-url]", 9],
    });
    expect(event.request?.query_string).not.toContain("rpc.example.com");
    expect(event.request?.query_string).not.toContain("secret123");
    expect(event.request?.query_string).not.toMatch(/https?%3A%2F%2F/i);
    expect(event.request?.env).toMatchObject({
      NODE_ENV: "production",
      REMOTE_ADDR: "[redacted]",
      RPC_URL: "[redacted-url]",
      WORKER_ID: 7,
      NESTED: { authorization: "[redacted]", count: 1 },
    });
    expect(JSON.stringify(event)).not.toContain("198.51.100.10");
  });

  it("scrubs breadcrumbs as a plain SDK array, including data.url and RPC hosts", () => {
    const rpc = "https://mainnet.helius-rpc.com/example-key";
    const event = scrubSentryEvent({
      user: { geo: { city: "San Francisco", country_code: "US" }, ip_address: "198.51.100.10" },
      extra: {
        description: "Raydium CLMM pool account does not exist",
        zip: "94107",
        client_ip: "198.51.100.10",
      },
      breadcrumbs: [
        {
          category: "http",
          message: `POST ${rpc}`,
          data: {
            url: rpc,
            method: "POST",
            "url.query": "api-key=secret123",
            status_code: 200,
          },
        },
      ],
    });

    expect(event.user).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("San Francisco");
    expect(event.extra).toMatchObject({
      description: "Raydium CLMM pool account does not exist",
      zip: "94107",
      client_ip: "[redacted]",
    });
    const crumb = event.breadcrumbs?.[0];
    expect(crumb?.message).toContain("[redacted-url]");
    expect(crumb?.message).not.toContain("helius-rpc");
    expect(crumb?.data?.url).toBe("[redacted-url]");
    expect(crumb?.data?.["url.query"]).not.toContain("secret123");
    expect(crumb?.data?.method).toBe("POST");
    expect(JSON.stringify(event)).not.toContain("helius");
    expect(JSON.stringify(event)).not.toContain("example-key");
  });
});

describe("scrubBreadcrumb", () => {
  it("redacts RPC hostnames and paths in message and data.url", () => {
    const crumb = scrubBreadcrumb({
      category: "http",
      message: "GET https://mainnet.helius-rpc.com/example-key",
      data: { url: "https://mainnet.helius-rpc.com/example-key", method: "GET" },
    });
    expect(crumb.message).toBe("GET [redacted-url]");
    expect(crumb.data?.url).toBe("[redacted-url]");
    expect(crumb.data?.method).toBe("GET");
    expect(JSON.stringify(crumb)).not.toContain("helius");
  });
});

describe("scrubUnknown", () => {
  it("passes primitives through and redacts env-like objects", () => {
    expect(scrubUnknown(undefined)).toBeUndefined();
    expect(scrubUnknown(null)).toBeNull();
    expect(scrubUnknown(0)).toBe(0);
    expect(scrubUnknown({ HTTP_X_FORWARDED_FOR: "198.51.100.10", keep: "ok" })).toEqual({
      HTTP_X_FORWARDED_FOR: "[redacted]",
      keep: "ok",
    });
    expect(scrubUnknown({
      description: "pool missing",
      zip: "94107",
      client_ip: "198.51.100.10",
      ip_address: "198.51.100.10",
    })).toEqual({
      description: "pool missing",
      zip: "94107",
      client_ip: "[redacted]",
      ip_address: "[redacted]",
    });
  });
});

describe("minimalSentryEvent", () => {
  it("keeps exception type/message and route, and strips request PII", () => {
    const event = minimalSentryEvent({
      message: `failed wallet=${wallet}`,
      exception: { values: [{ type: "Error", value: "Raydium CLMM pool account does not exist" }] },
      tags: { route: "/api/pool-range-apr", extra: "drop-me" },
      extra: { token: "abc" },
      user: { ip_address: "198.51.100.10" },
      breadcrumbs: { values: [{ message: "x" }] },
      request: {
        url: "https://sofinancelab.xyz/api/pool-range-apr?poolId=11111111111111111111111111111112",
        method: "GET",
        headers: { "x-forwarded-for": ["198.51.100.10"] },
        env: { REMOTE_ADDR: "198.51.100.10" },
        query_string: "poolId=111",
        cookies: { session: "abc" },
      },
    });

    expect(event.exception?.values?.[0]).toEqual({
      type: "Error",
      value: "Raydium CLMM pool account does not exist",
    });
    expect(event.message).toContain("[redacted-address]");
    expect(event.tags).toEqual({ route: "/api/pool-range-apr" });
    expect(event.user).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.request).toEqual({
      url: "https://sofinancelab.xyz/api/pool-range-apr",
      method: "GET",
    });
  });
});
