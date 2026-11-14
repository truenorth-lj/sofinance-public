import { describe, expect, it } from "vitest";
import { listToolDefinitions } from "@/mcp/tool-definitions";
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

  it("keeps the public-copy rules", async () => {
    const text = JSON.stringify(await GET().json());
    expect(text).not.toMatch(/\byield|\bearn\b|guarantee|backtest|auto-rebalanc|open[- ]source|Turnkey|fee wallet|Taiwan/i);
  });
});
