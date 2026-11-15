import { beforeEach, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dex", () => ({ readPortfolio: read }));
import { POST } from "./route";
import { resetDexRouteRateLimit } from "@/lib/dex-route-rate-limit";
const mint = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const input = { wallet: mint, positions: [{ key: `raydium-clmm:${mint}` }] };
const request = (body: unknown) => new Request("https://example.test/api/portfolio", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => { read.mockReset(); resetDexRouteRateLimit(); });
it("returns a private aggregate with a bounded cancellation signal", async () => {
  read.mockResolvedValue({ wallet: mint, positions: [] });
  const response = await POST(request(input));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(read).toHaveBeenCalledWith(input, expect.any(AbortSignal));
});
it("validates keys, decoded public keys, signature sizes and position bounds before I/O", async () => {
  for (const body of [{ ...input, wallet: "bad" }, { ...input, positions: Array(51).fill(input.positions[0]) },
    { ...input, positions: [{ key: `raydium-clmm:${"z".repeat(44)}` }] },
    { ...input, positions: [{ ...input.positions[0], afterSignatures: ["bad"] }] }, { ...input, extra: true }]) {
    expect((await POST(request(body))).status).toBe(400);
  }
  expect(read).not.toHaveBeenCalled();
});
it("bounds the body and suppresses internal errors", async () => {
  expect((await POST(request("x".repeat(60_001)))).status).toBe(413);
  read.mockRejectedValue(new Error("secret endpoint"));
  const response = await POST(request(input));
  expect(response.status).toBe(503); expect(JSON.stringify(await response.json())).not.toContain("secret");
});
it("rate limits repeated heavy requests", async () => {
  read.mockResolvedValue({});
  for (let i = 0; i < 12; i++) expect((await POST(request(input))).status).toBe(200);
  const response = await POST(request(input));
  expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("60"); expect(read).toHaveBeenCalledTimes(12);
});
