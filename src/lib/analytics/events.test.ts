import { describe, expect, it } from "vitest";
import { openEventProperties } from "./events";

const pair = { poolAddress: "pool", symbolA: "SPCXx", symbolB: "SPCX" };

describe("open event properties", () => {
  it("adds the wallet address and input kind when known, with no internal tagging", () => {
    const wallet = "So11111111111111111111111111111111111111112";
    expect(openEventProperties(pair, { wallet, inputKind: "native" })).toEqual({
      source: "web", wallet_address: wallet, input_kind: "native", pool: "pool", pair: "SPCXx/SPCX",
    });
  });

  it("always tags source web; other fields only when known", () => {
    expect(openEventProperties(pair)).toEqual({ source: "web", pool: "pool", pair: "SPCXx/SPCX" });
    expect(openEventProperties(null)).toEqual({ source: "web" });
  });

  it("tags a web open from an MCP sign link, still source web", () => {
    expect(openEventProperties(pair, { mcpSignLink: true })).toEqual({
      source: "web", mcp_sign_link: true, pool: "pool", pair: "SPCXx/SPCX",
    });
  });
});
