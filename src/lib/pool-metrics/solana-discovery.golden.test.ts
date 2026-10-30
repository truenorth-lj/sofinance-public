import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../onchain-mint-freeze", () => ({ readMintFreezeAuthorities: async () => new Map() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({}) }));

import { clearRwaPairsCache, discoverRwaPairs } from "../rwa-pairs";
import { clearJupiterTagsCache } from "../rwa-jupiter-tags";
import { clearXstocksWhitelistCache } from "../rwa-xstocks-whitelist";

/**
 * Zero-behaviour-change guard for the Solana RWA pair discovery. The inputs are a real recording
 * (2026-10-30) of the Raydium CLMM scan (rows that pass the structural / allowlist gate), the Jupiter tag
 * lookup and the Backed xStocks list (fields the parsers read). The golden is what the discovery produced
 * from them BEFORE the token-registry refactor; the refactored code must produce exactly the same result.
 * Regenerate only on an intended behaviour change: UPDATE_GOLDEN=1 npx vitest run <this file>.
 */
const dir = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const inputs = JSON.parse(readFileSync(`${dir}solana-discovery-inputs.json`, "utf8")) as {
  responses: Record<string, { status: number; body: unknown }>;
};
const byPath = new Map(Object.entries(inputs.responses).map(([url, value]) => {
  const parsed = new URL(url);
  return [`${parsed.hostname === "lite-api.jup.ag" ? "api.jup.ag" : parsed.hostname}${parsed.pathname}${parsed.search}`, value];
}));

const replay = (async (input: RequestInfo | URL) => {
  const parsed = new URL(String(input instanceof Request ? input.url : input));
  const hit = byPath.get(`${parsed.hostname === "lite-api.jup.ag" ? "api.jup.ag" : parsed.hostname}${parsed.pathname}${parsed.search}`);
  if (!hit) throw new Error(`unrecorded request ${parsed.hostname}${parsed.pathname}`);
  return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

/** Timestamps are the only run-dependent fields. */
function normalise(result: Awaited<ReturnType<typeof discoverRwaPairs>>) {
  const { discovery, ...rest } = result;
  return {
    ...rest,
    fetchedAt: undefined,
    discovery: discovery && { sourcePages: discovery.sourcePages, pageCounts: discovery.pageCounts, pools: Object.keys(discovery.poolObservedAt).sort() },
  };
}

describe("Solana RWA pair discovery golden (recorded 2026-10-30)", () => {
  afterEach(() => { clearRwaPairsCache(); clearJupiterTagsCache(); clearXstocksWhitelistCache(); });

  it("discovers exactly the recorded pair set with the same row shape", async () => {
    const result = normalise(await discoverRwaPairs({
      minTvl: 0, maxPages: 10, sortBy: "estimatedFeeApr", fetcher: replay, bypassCache: true, jupiterApiKey: "", connection: {} as never,
    }));
    const goldenPath = `${dir}solana-discovery-golden.json`;
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(goldenPath, `${JSON.stringify(result, null, 1)}\n`);
    expect(result).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
    expect(result.pairs.length).toBeGreaterThan(0);
  });
});
