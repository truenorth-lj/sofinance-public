import { describe, expect, it } from "vitest";
import { scrubSensitiveText, scrubSentryEvent } from "./scrub";

const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const signature = "1".repeat(88);

describe("scrubSensitiveText", () => {
  it("redacts RPC URLs, API keys, wallet addresses, and signatures", () => {
    const raw = `RPC https://rpc.example/sol?api_key=secret123 failed wallet=${wallet} sig=${signature} authorization=Bearer-abc`;
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

describe("scrubSentryEvent", () => {
  it("scrubs exception text, drops request bodies/cookies/user, and keeps route tags", () => {
    const event = scrubSentryEvent({
      message: `boom ${wallet}`,
      exception: { values: [{ value: `Jupiter HTTP 429 from https://quotes.example/swap?api_key=leak` }] },
      tags: { route: "/api/selected-quote", error_class: "JupiterHttpError", wallet },
      extra: { token: "abc", public_message: "ok" },
      user: { ip_address: "1.2.3.4", id: wallet },
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
    expect(event.request?.headers?.authorization).toBe("[redacted]");
    expect(event.request?.url).toContain("[redacted-url]");
    expect(event.breadcrumbs?.values?.[0]?.message).toContain("[redacted-signature]");
    expect(event.breadcrumbs?.values?.[0]?.data?.apiKey).toBe("[redacted]");
  });
});
