import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyAppPath,
  isRegionBlockedApi,
  isRegionBlockedMcpTool,
  REGION_BLOCKED_API_ROUTES,
  REGION_EXEMPT_EXIT_API_ROUTES,
} from "./region-routes";

function apiRoutes(): string[] {
  const root = resolve("src/app/api");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name === "route.ts") out.push(`/api/${dir.slice(root.length + 1)}`);
    }
  };
  walk(root);
  return out;
}

describe("restricted-region route policy", () => {
  it("never blocks withdrawal or recovery APIs", () => {
    for (const route of REGION_EXEMPT_EXIT_API_ROUTES) expect(isRegionBlockedApi(route)).toBe(false);
    for (const route of apiRoutes().filter((path) => /withdraw|recover|cleanup/.test(path))) expect(isRegionBlockedApi(route)).toBe(false);
  });

  it("blocks every route that opens, adds to or compounds a position", () => {
    const orderRoutes = apiRoutes().filter((path) => /^\/api\/(open|selected|compound)-(quote|preflight|prepare|broadcast)$/.test(path));
    expect(orderRoutes.sort()).toEqual([...REGION_BLOCKED_API_ROUTES].sort());
    for (const route of orderRoutes) {
      expect(isRegionBlockedApi(route)).toBe(true);
      expect(isRegionBlockedApi(`${route}/`)).toBe(true);
    }
  });

  it("lists only routes that exist", () => {
    const routes = new Set(apiRoutes());
    for (const route of [...REGION_BLOCKED_API_ROUTES, ...REGION_EXEMPT_EXIT_API_ROUTES]) expect(routes.has(route)).toBe(true);
  });

  it("keeps read-only and status APIs open", () => {
    for (const route of ["/api/wallet", "/api/rwa-pairs", "/api/selected-state", "/api/open-status", "/api/selected-status",
      "/api/compound-state", "/api/compound-confirm", "/api/transaction-finality", "/api/verify-sign-token", "/api/mcp", "/api/mcp-token"]) {
      expect(isRegionBlockedApi(route)).toBe(false);
    }
  });

  it("classifies /app pages", () => {
    expect(classifyAppPath("/app")).toBe("block");
    expect(classifyAppPath("/app/")).toBe("block");
    expect(classifyAppPath("/app/rwa-pairs")).toBe("block");
    expect(classifyAppPath("/app/ai")).toBe("block");
    expect(classifyAppPath("/app/exit")).toBe("allow");
    expect(classifyAppPath("/app/sign/abc.def")).toBe("sign-link");
    expect(classifyAppPath("/")).toBe("allow");
    expect(classifyAppPath("/docs/withdraw")).toBe("allow");
    expect(classifyAppPath("/terms")).toBe("allow");
    expect(classifyAppPath("/application")).toBe("allow");
  });

  it("blocks transaction-building MCP tools but not withdraw or read-only tools", () => {
    for (const tool of ["prepare_open_position", "submit_open_position", "quote_open_position", "prepare_transaction",
      "submit_signed_transaction", "quote_add_liquidity", "quote_compound", "prepare_compound_transaction", "submit_compound_transaction"]) {
      expect(isRegionBlockedMcpTool(tool)).toBe(true);
    }
    for (const tool of ["prepare_withdraw", "submit_withdraw", "list_positions", "list_rwa_pairs", "get_position_performance", 42]) {
      expect(isRegionBlockedMcpTool(tool)).toBe(false);
    }
  });
});
