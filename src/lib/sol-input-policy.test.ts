import { afterEach, describe, expect, it, vi } from "vitest";

const flag = vi.hoisted(() => ({ enabled: false }));
vi.mock("./feature-flags", async (importOriginal) => ({
  ...await importOriginal<typeof import("./feature-flags")>(),
  get SOL_INPUT_ENABLED() { return flag.enabled; },
}));

import { SOL_INPUT_DISABLED_MESSAGE } from "./feature-flags";
import { applySolInputPolicy, assertSolInputAllowed, isSolInputBlocked, SolInputDisabledError } from "./sol-input-policy";

const sol = { kind: "native" as const, mint: "So11111111111111111111111111111111111111112", eligible: true, reason: null };
const wsol = { kind: "token" as const, mint: "So11111111111111111111111111111111111111112", eligible: true, reason: null };
const usdc = { kind: "token" as const, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", eligible: true, reason: null };

afterEach(() => { flag.enabled = false; });

describe("SOL input switch", () => {
  it("ships enabled (fee inside the Jupiter swap) and keeps the agreed off-switch note", async () => {
    const actual = await vi.importActual<typeof import("./feature-flags")>("./feature-flags");
    expect(actual.SOL_INPUT_ENABLED).toBe(true);
    expect(SOL_INPUT_DISABLED_MESSAGE).toBe("SOL deposits are temporarily unavailable — please use another token.");
  });

  it("marks only native SOL ineligible while off, leaving other tokens untouched", () => {
    const result = applySolInputPolicy([sol, wsol, usdc]);
    expect(result[0]).toEqual({ ...sol, eligible: false, reason: SOL_INPUT_DISABLED_MESSAGE });
    expect(result[1]).toBe(wsol);
    expect(result[2]).toBe(usdc);
    expect(isSolInputBlocked("native")).toBe(true);
    expect(isSolInputBlocked("token")).toBe(false);
  });

  it("server guard rejects native SOL with a clear coded error and allows tokens", () => {
    expect(() => assertSolInputAllowed({ inputKind: "native" })).toThrow(SolInputDisabledError);
    expect(() => assertSolInputAllowed({ inputKind: "native" })).toThrow(SOL_INPUT_DISABLED_MESSAGE);
    expect(new SolInputDisabledError().code).toBe("sol_input_disabled");
    expect(() => assertSolInputAllowed({ inputKind: "token" })).not.toThrow();
  });

  it("restores SOL everywhere when flipped on", () => {
    flag.enabled = true;
    const assets = [sol, usdc];
    expect(applySolInputPolicy(assets)).toBe(assets);
    expect(isSolInputBlocked("native")).toBe(false);
    expect(() => assertSolInputAllowed({ inputKind: "native" })).not.toThrow();
  });
});
