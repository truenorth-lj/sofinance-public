import { describe, expect, it } from "vitest";
import { openEventProperties } from "./events";
import { INTERNAL_WALLETS } from "./internal-wallets";

const pair = { poolAddress: "pool", symbolA: "SPCXx", symbolB: "SPCX" };

describe("open event properties", () => {
  it("adds the wallet address, is_internal and input kind when known", () => {
    expect(openEventProperties(pair, { wallet: INTERNAL_WALLETS[0]!, inputKind: "native" })).toEqual({
      wallet_address: INTERNAL_WALLETS[0]!, is_internal: true, input_kind: "native", pool: "pool", pair: "SPCXx/SPCX",
    });
    const external = "So11111111111111111111111111111111111111112";
    expect(openEventProperties(pair, { wallet: external })).toMatchObject({ wallet_address: external, is_internal: false });
  });

  it("keeps the old shape without context", () => {
    expect(openEventProperties(pair)).toEqual({ pool: "pool", pair: "SPCXx/SPCX" });
    expect(openEventProperties(null)).toEqual({});
  });
});
