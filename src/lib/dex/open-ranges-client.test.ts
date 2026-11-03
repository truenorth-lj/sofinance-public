import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenRanges, OPEN_RANGES_UNAVAILABLE } from "./client";

const respond = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => Response.json(body, { status })));
afterEach(() => vi.unstubAllGlobals());

describe("fetchOpenRanges failure copy", () => {
  it("a server / upstream failure (502 RWA_STORE_UNAVAILABLE) shows plain words, never the code", async () => {
    respond(502, { error: "The Meteora request could not be completed: RWA_STORE_UNAVAILABLE", code: "UPSTREAM" });
    await expect(fetchOpenRanges("meteora-dlmm", "pool")).rejects.toThrow(OPEN_RANGES_UNAVAILABLE);
  });
  it("no JSON answer at all is the same plain message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 504 })));
    await expect(fetchOpenRanges("meteora-dlmm", "pool")).rejects.toThrow(OPEN_RANGES_UNAVAILABLE);
  });
  it("a refusal (4xx) keeps the server's plain reason", async () => {
    respond(422, { error: "This Meteora pool is not on SoFinance's pool list, so it can't be opened here yet.", code: "UNSUPPORTED" });
    await expect(fetchOpenRanges("meteora-dlmm", "pool")).rejects.toThrow("not on SoFinance's pool list");
  });
});
