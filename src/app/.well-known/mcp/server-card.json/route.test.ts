import { describe, expect, it } from "vitest";
import { listToolDefinitions } from "@/mcp/tool-definitions";
import serverJson from "../../../../../server.json";
import { dynamic, GET } from "./route";

describe("/.well-known/mcp/server-card.json", () => {
  it("serves a static card that matches the live tools/list", async () => {
    expect(dynamic).toBe("force-static");
    const card = await GET().json();
    expect(card.serverInfo).toMatchObject({ name: "sofinance-mcp-server", version: "0.2.0" });
    expect(card.transport).toEqual({ type: "streamable-http", endpoint: "https://sofinancelab.xyz/api/mcp" });
    expect(card.protocolVersion).toBe("2025-06-18");
    expect(card.authentication).toMatchObject({ required: false, schemes: ["bearer"], publicTools: ["list_rwa_pairs", "get_pool_range_apr"] });
    expect(card.tools).toEqual(listToolDefinitions("http"));
    expect(card.tools.every((tool: { annotations?: unknown }) => tool.annotations)).toBe(true);
  });

  it("takes its short description from server.json: Raydium and Meteora, at most 100 characters", async () => {
    const card = await GET().json();
    expect(card.description).toBe(serverJson.description);
    expect(card.description).toBe("List same-stock LP pools on Raydium and Meteora, with 7-day fee APR estimates. Fees not guaranteed.");
    expect(card.description.length).toBeLessThanOrEqual(100);
    expect(serverJson.version).toBe(card.serverInfo.version);
  });

  it("keeps the public-copy rules", async () => {
    // "guaranteed" is banned except the one approved risk line, exactly "Fees not guaranteed" (LJ via PM).
    const text = JSON.stringify(await GET().json()).replace(/\bFees not guaranteed\b/g, "");
    expect(text).not.toMatch(/\byield|\bearn\b|guarantee|backtest|auto-rebalanc|open[- ]source|Turnkey|fee wallet|Taiwan/i);
  });
});
