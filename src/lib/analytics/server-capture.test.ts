import { describe, expect, it, vi } from "vitest";
import { sendServerEvents, walletDistinctId, type ServerEvent } from "./server-capture";

const event: ServerEvent = { event: "mcp_tool_called", distinctId: "mcp:anonymous", properties: { tool: "tx_status" } };
const prod = { VERCEL_ENV: "production", NEXT_PUBLIC_POSTHOG_KEY: "phc_test_key" };
const now = () => new Date("2026-11-23T15:00:00.000Z");

describe("server PostHog capture", () => {
  it("wallet distinct id is the legacy wallet:<sha256 hex> form sofi-metrics already folds", () => {
    expect(walletDistinctId("So11111111111111111111111111111111111111112"))
      .toBe("wallet:d77cf5c8a1c79d6b78408a3f545dea88441790fb0245268398f1d09455e29b18");
  });

  it.each([
    ["preview", { ...prod, VERCEL_ENV: "preview" }],
    ["local/test (no VERCEL_ENV)", { NEXT_PUBLIC_POSTHOG_KEY: "phc_test_key" }],
    ["no project key", { VERCEL_ENV: "production" }],
  ])("sends nothing on %s", async (_label, env) => {
    const fetchImpl = vi.fn();
    await sendServerEvents([event], { env, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends nothing for an empty batch", async () => {
    const fetchImpl = vi.fn();
    await sendServerEvents([], { env: prod, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("production: one /batch/ call, personless, GeoIP off, no IP property", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    await sendServerEvents([event, { ...event, event: "open_position_success" }], { env: prod, fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://us.i.posthog.com/batch/");
    const body = JSON.parse(String(init.body));
    expect(body.api_key).toBe("phc_test_key");
    expect(body.batch).toHaveLength(2);
    expect(body.batch[0]).toEqual({
      event: "mcp_tool_called", distinct_id: "mcp:anonymous", timestamp: "2026-11-23T15:00:00.000Z",
      properties: { tool: "tx_status", $process_person_profile: false, $geoip_disable: true, $lib: "sofinance-server" },
    });
    expect(JSON.stringify(body)).not.toContain("$ip");
  });

  it("uses the configured PostHog host", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    await sendServerEvents([event], { env: { ...prod, NEXT_PUBLIC_POSTHOG_HOST: "https://eu.i.posthog.com/" }, fetchImpl });
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://eu.i.posthog.com/batch/");
  });

  it("swallows a failed capture", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    await expect(sendServerEvents([event], { env: prod, fetchImpl })).resolves.toBeUndefined();
  });
});
