import { describe, expect, it } from "vitest";
import { openEventProperties } from "./events";

const pair = { poolAddress: "pool", symbolA: "SPCXx", symbolB: "SPCX" };

describe("open event properties", () => {
  it("adds the wallet address and input kind when known, with no internal tagging", () => {
    const wallet = "So11111111111111111111111111111111111111112";
    expect(openEventProperties(pair, { wallet, inputKind: "native" })).toEqual({
      wallet_address: wallet, input_kind: "native", pool: "pool", pair: "SPCXx/SPCX",
    });
  });

  it("keeps the old shape without context", () => {
    expect(openEventProperties(pair)).toEqual({ pool: "pool", pair: "SPCXx/SPCX" });
    expect(openEventProperties(null)).toEqual({});
  });
});
