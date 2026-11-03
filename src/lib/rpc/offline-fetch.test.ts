import { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { OfflineFetchError, setFetchReplay } from "@/lib/test-support/offline-fetch";

// @solana/web3.js copies globalThis.fetch into its own `fetchImpl` when it loads, so a spy installed later never sees
// Connection traffic. The vitest setup file installs the guard before any module loads; these tests prove it holds
// (they live in src/lib/rpc because only RPC code may construct a Connection; see guard.test.ts).
const RPC = "https://rpc.offline.invalid";

describe("offline fetch guard (vitest setup)", () => {
  it("fails an unmocked @solana/web3.js Connection call instead of reaching the network", async () => {
    await expect(new Connection(RPC, { disableRetryOnRateLimit: true }).getSlot()).rejects.toThrow(/blocked in unit tests/);
  });

  it("fails an unmocked global fetch with OfflineFetchError", async () => {
    await expect(fetch("https://example.invalid/x")).rejects.toBeInstanceOf(OfflineFetchError);
  });

  it("routes Connection traffic captured at load time to the active replay (how the DEX contract suite answers it)", async () => {
    const seen: string[] = [];
    const restore = setFetchReplay(async (input, init) => {
      seen.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host);
      const { id } = JSON.parse(String(init?.body)) as { id: string };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: 464_010_023 }), { headers: { "content-type": "application/json" } });
    });
    try {
      await expect(new Connection(RPC).getSlot()).resolves.toBe(464_010_023);
    } finally {
      restore();
    }
    expect(seen).toEqual(["rpc.offline.invalid"]);
    await expect(new Connection(RPC, { disableRetryOnRateLimit: true }).getSlot()).rejects.toThrow(/blocked in unit tests/);
  });
});
