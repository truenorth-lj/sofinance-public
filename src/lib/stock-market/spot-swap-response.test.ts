import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn }));

import { SpotSwapError } from "@sofinance/engine/spot-swap";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import { JupiterRelayMissingError } from "@sofinance/engine/jupiter/client";
import { SPOT_SWAP_SAFETY_MESSAGE, spotSwapErrorResponse } from "./spot-swap-response";

const read = async (response: Response) => ({ status: response.status, body: await response.json() as { error: string; code?: string; sol?: unknown } });
const CODE_LIKE = /\b(spot_swap_\w+|0x[0-9a-f]+|\{|InstructionError|Custom)\b/i;

describe("spotSwapErrorResponse", () => {
  it("passes the engine's price-impact refusal through as plain words", async () => {
    const message = "There isn't enough trading liquidity to buy this amount without moving the price more than 1%. Try a smaller amount.";
    const { status, body } = await read(spotSwapErrorResponse(new SpotSwapError("spot_swap_price_impact", message), "x", "/api/spot-swap-quote"));
    expect(status).toBe(400);
    expect(body).toEqual({ error: message, code: "spot_swap_price_impact" });
  });

  it("never shows technical safety failures: one generic sentence, no codes or JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const error of [new SpotSwapError("spot_swap_simulation_failed", 'Spot swap simulation failed: {"InstructionError":[2,{"Custom":6001}]}'),
      new SpotSwapError("spot_swap_fee_mismatch", "Simulated protocol fee does not equal the quoted fee")]) {
      const { body } = await read(spotSwapErrorResponse(error, "x", "/api/spot-swap-prepare"));
      expect(body.error).toBe(SPOT_SWAP_SAFETY_MESSAGE);
      expect(body.error).not.toMatch(CODE_LIKE);
    }
  });

  it("insufficient SOL carries the requirement for the modal", async () => {
    const sol = { requiredLamports: "2044280", walletLamports: "1000" };
    const { body } = await read(spotSwapErrorResponse(new SpotSwapError("spot_swap_insufficient_sol", "x", sol), "x", "/api/spot-swap-prepare"));
    expect(body).toMatchObject({ error: "Not enough SOL to cover the one-time deposit and the network fee.", sol });
  });

  it("a route below the confirmed minimum carries the new terms and plain words", async () => {
    const terms = { quotedOut: "2250000", minOut: "2238750", priceImpactPct: "0.0009" };
    const message = "The price moved since your quote, so nothing was prepared. Check the new amount and press Buy again.";
    const { status, body } = await read(spotSwapErrorResponse(new SpotSwapError("spot_swap_quote_changed", message, terms), "x", "/api/spot-swap-prepare"));
    expect(status).toBe(400);
    expect(body).toEqual({ error: message, code: "spot_swap_quote_changed", quote: terms });
    expect(body.error).not.toMatch(CODE_LIKE);
  });

  it("Jupiter outage is a 503, and the relay step is rethrown for withJupiterRelay", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(spotSwapErrorResponse(new JupiterHttpError(503, "/swap/v1/quote"), "Quote failed.", "/api/spot-swap-quote").status).toBe(503);
    const pending = new JupiterRelayMissingError({} as ConstructorParameters<typeof JupiterRelayMissingError>[0]);
    expect(() => spotSwapErrorResponse(pending, "x", "/api/spot-swap-quote")).toThrow(pending);
  });

  it("anything unexpected gets the route's plain fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await read(spotSwapErrorResponse(new Error("socket hang up at 10.0.0.1"), "Quote failed. Please try again.", "/api/spot-swap-quote"));
    expect(status).toBe(500);
    expect(body.error).toBe("Quote failed. Please try again.");
  });
});
