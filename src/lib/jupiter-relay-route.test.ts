import { describe, expect, it, vi } from "vitest";
import { jupiterRequest, setJupiterRelayHint } from "@sofinance/engine/jupiter/client";
import { jupiterRelayId } from "@sofinance/engine/jupiter/relay";
import { JUPITER_RELAY_HINTS_HEADER, withJupiterRelay } from "./jupiter-relay-route";

vi.mock("server-only", () => ({}));

const post = (body: unknown) => new Request("http://localhost/api/open-quote", { method: "POST", body: JSON.stringify(body) });
const quoteUrl = "/swap/v1/quote?inputMint=A&outputMint=B&amount=1";
const run = (request: Request) => withJupiterRelay(request, async () => {
  await request.json();
  const quote = await jupiterRequest<{ out: string }>({ path: "/swap/v1/quote", query: { inputMint: "A", outputMint: "B", amount: "1" },
    fetcher: (async () => Response.json({ out: "server" })) as never });
  return Response.json(quote);
});

describe("withJupiterRelay", () => {
  it("leaves requests without jupiterRelay on the server-keyed path (MCP, old clients)", async () => {
    expect(await (await run(post({ wallet: "w" }))).json()).toEqual({ out: "server" });
  });

  it("answers 409 jupiter_relay_needed with the exact Jupiter requests", async () => {
    const response = await run(post({ wallet: "w", jupiterRelay: { responses: {} } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "jupiter_relay_needed", error: "Jupiter quotes required",
      needs: [{ id: jupiterRelayId({ method: "GET", url: quoteUrl }), method: "GET", url: quoteUrl }], hints: {} });
  });

  it("serves the browser's responses instead of calling Jupiter", async () => {
    const id = jupiterRelayId({ method: "GET", url: quoteUrl });
    const response = await run(post({ wallet: "w", jupiterRelay: { responses: { [id]: { status: 200, body: { out: "browser" } } } } }));
    expect(await response.json()).toEqual({ out: "browser" });
  });

  it("rejects a malformed relay payload", async () => {
    expect((await run(post({ jupiterRelay: { responses: { bad: {} } } }))).status).toBe(400);
  });

  it("returns sizing hints with needs and on the final response", async () => {
    const hinted = (request: Request) => withJupiterRelay(request, async () => {
      setJupiterRelayHint("k", 42n);
      return Response.json({ ok: true });
    });
    const response = await hinted(post({ jupiterRelay: { responses: {}, hints: { k: "1" } } }));
    expect(JSON.parse(response.headers.get(JUPITER_RELAY_HINTS_HEADER)!)).toEqual({ k: "42" });
    expect((await run(post({ jupiterRelay: { responses: {}, hints: { k: "1" } } }))).status).toBe(409);
  });
});
